import * as ort from "onnxruntime-web/wasm"

const MODEL_PATH = "models/comic-text-detector/comictextdetector.pt.onnx"
const CTD_INPUT_SIZE = 1024
const CTD_CONFIDENCE_THRESHOLD = 0.4
const CTD_NMS_THRESHOLD = 0.35

let session = null

function calculateIoU(a, b){
    const intersectionX1 = Math.max(a.x1, b.x1) 
    const intersectionY1 = Math.max(a.y1, b.y1)
    const intersectionX2 = Math.min(a.x2, b.x2)
    const intersectionY2 = Math.min(a.y2, b.y2)
    const intersectionWidth = Math.max(0, intersectionX2 - intersectionX1)
    const intersectionHeight = Math.max(0, intersectionY2 - intersectionY1)
    const intersectionArea = intersectionWidth * intersectionHeight
    const areaA = (a.x2 - a.x1) * (a.y2 - a.y1)
    const areaB = (b.x2 - b.x1) * (b.y2 - b.y1)
    const union = areaA + areaB - intersectionArea

    if(union <= 0) return 0

    return intersectionArea / union
}

function decodeBlockOutput(blockTensor, transform){
    const data = blockTensor.data
    const dims = blockTensor.dims

    console.log("Decodificando blk: ", dims)

    if(dims.length !== 3 || dims[2] !== 7) throw new Error(`Formato blk inesperado ${dims}`)

    const predictionCount = dims[1]

    const candidates = []

    for(let prediction = 0; prediction < predictionCount; prediction++){
        const offset = prediction * 7
        const centerX = data[offset]
        const centerY =  data[offset + 1]
        const width = data[offset + 2]
        const height = data[offset + 3]
        const objectness = data[offset + 4]

        if(objectness < CTD_CONFIDENCE_THRESHOLD) continue

        const class0Score = data[offset + 5] * objectness
        const class1Score = data[offset + 6] * objectness

        let classId
        let confidence
        if(class0Score > class1Score){
            classId = 0
            confidence = class0Score
        }else{
            classId = 1
            confidence = class1Score
        }

        if(confidence < CTD_CONFIDENCE_THRESHOLD) continue
        
        const x1 = centerX - width / 2
        const y1 = centerY - height / 2
        const x2 = centerX + width / 2
        const y2 = centerY + height / 2

        candidates.push({
            x1,
            y1,
            x2,
            y2,
            confidence,
            classId
        })
    }
    console.log("Candidatos apos confidence:",candidates.length)

    const selected = nonMaxSupression(candidates)

    console.log("Caixas apos NMS: ", selected.length)

    return scaleBoxesToOriginal(selected, transform)
}

function nonMaxSupression(boxes, iouThreshold = CTD_NMS_THRESHOLD){
    const sorted = [...boxes].sort((a,b) => b.confidence - a.confidence)
    const selected = []

    while(sorted.length > 0){
        const best = sorted.shift()
        
        selected.push(best)

        for(let i = sorted.length - 1; i >= 0; i--){
            const candidate = sorted[i]

            if(candidate.classId !== best.classId)continue

            const iou = calculateIoU(best, candidate)

            if(iou > iouThreshold){
                sorted.splice(i, 1)
            }
        }
    }
    return selected
}

function configureOnnxRuntime(){
    const wasmUrl = chrome.runtime.getURL("runtime/onnx/ort-wasm-simd-threaded.wasm")
    const mjsUrl = chrome.runtime.getURL("runtime/onnx/ort-wasm-simd-threaded.mjs")

    ort.env.wasm.wasmPaths = {
        wasm: wasmUrl,
        mjs: mjsUrl
    }
    ort.env.wasm.numThreads = 1
    ort.env.wasm.proxy = false

    console.log("ONNX WASM configurado")
    console.log("WASM: ", wasmUrl)
    console.log("MJS: ", mjsUrl)
}

function calculateLetterbox(originalWidth, originalHeight, targetSize = CTD_INPUT_SIZE){
    const ratio = Math.min(targetSize / originalHeight, targetSize / originalWidth)
    const resizedWidth = Math.round(originalWidth * ratio)
    const resizedHeight = Math.round(originalHeight * ratio)
    const paddingRight = targetSize - resizedWidth
    const paddingBottom = targetSize - resizedHeight

    return {
        ratio,
        resizedWidth,
        resizedHeight,
        paddingRight,
        paddingBottom  
    }
}

function loadImage(url){
    return new Promise((resolve, reject) => {
        const image = new Image()

        image.onload = () => {
            resolve(image)
        }
        image.onerror = () => {
            reject(new Error(`Não foi possivel carregar imagem: ${url}`))
        }
        image.src = url
    })
}

function preprocessImage(image){
    const {
        ratio, 
        resizedWidth, 
        resizedHeight, 
        paddingRight, 
        paddingBottom
    } = calculateLetterbox(image.naturalWidth, image.naturalHeight)

    const canvas = document.createElement("canvas")

    canvas.width = CTD_INPUT_SIZE
    canvas.height = CTD_INPUT_SIZE

    const context = canvas.getContext("2d", {
        willReadFrequently: true
    })

    if(!context) throw new Error("Não foi possivel criar contexto 2D")

    context.fillStyle = "rgb(0, 0, 0)"
    context.fillRect(0, 0, CTD_INPUT_SIZE, CTD_INPUT_SIZE)
    context.drawImage(image, 0, 0, resizedWidth, resizedHeight)

    const imageData = context.getImageData(0, 0, CTD_INPUT_SIZE, CTD_INPUT_SIZE)

    const pixelCount = CTD_INPUT_SIZE * CTD_INPUT_SIZE
    const tensorData = new Float32Array(pixelCount * 3)


    for(let pixel = 0; pixel < pixelCount; pixel++){
            const rgbaIndex = pixel * 4
            const red = imageData.data[rgbaIndex]
            const green = imageData.data[rgbaIndex + 1]
            const blue = imageData.data[rgbaIndex + 2]

            tensorData[pixel] = red / 255
            tensorData[pixelCount + pixel] = green / 255
            tensorData[(pixelCount * 2) + pixel] = blue / 255
    }

    const tensor = new ort.Tensor("float32", tensorData, [
        1, 3, CTD_INPUT_SIZE, CTD_INPUT_SIZE
    ])

    console.log("Quantidade de valores RGBA: ", imageData.data.length)

    console.log("Image original: ", {
        width: image.naturalWidth,
        height: image.naturalHeight
    })
    console.log("Letterbox: ", {
        ratio,
        resizedWidth,
        resizedHeight,
        paddingRight,
        paddingBottom
    })

    return {
        tensor,
        transform: {
            ratio,
            originalWidth: image.naturalWidth,
            originalHeight: image.naturalHeight,
            resizedWidth,
            resizedHeight,
            paddingRight,
            paddingBottom
        },
        canvas
    }
}

function scaleBoxesToOriginal(boxes, transform){
    const scaleX = transform.originalWidth / transform.resizedWidth
    const scaleY = transform.originalHeight / transform.resizedHeight

    return boxes.map(box => {
        let x1 = box.x1 * scaleX
        let y1 = box.y1 * scaleY
        let x2 = box.x2 * scaleX
        let y2 = box.y2 * scaleY


        x1 = Math.max(0, Math.min(transform.originalWidth, x1))
        y1 = Math.max(0, Math.min(transform.originalHeight, y1))
        x2 = Math.max(0, Math.min(transform.originalWidth, x2))
        y2 = Math.max(0, Math.min(transform.originalHeight, y2))

        return {
            ...box,
            x1,
            y1,
            x2,
            y2,
            width: x2 - x1,
            height: y2 - y1
        }
    })    
}

function inspectOutputs(outputs){
    console.log("Output names: ", Object.keys(outputs))

    for(const [name, tensor] of Object.entries(outputs)){
        console.log(`OUTPUT: ${name }`)
        console.log("type: ", tensor.type)
        console.log("dims: ", tensor.dims)
        console.log("size: ", tensor.size)
        console.log("sample:", tensor.data.slice(0,20))
    }
}

export function drawDebugBoxes(image, boxes){
    const canvas = document.createElement("canvas")

    canvas.width = image.naturalWidth
    canvas.height = image.naturalHeight

    const context = canvas.getContext("2d")

    if(!context) throw new Error("Não foi possivel criar canvas de debug")

    context.drawImage(image, 0, 0, image.naturalWidth, image.naturalHeight)
    context.lineWidth = 3
    context.strokeStyle = "red"
    context.font = "16px Arial"
    context.fillStyle = "red"

    boxes.forEach((box, index) => {
        context.strokeRect(box.x1, box.y1, box.width, box.height)
        context.fillText(
            `${index} - ${(box.confidence * 100).toFixed(1)}%`,
            box.x1, Math.max(16, box.y1 - 5)
        )
    })
    return canvas
}

export function testOnnxRuntime(){
    console.log("ONNX Runtime: ", ort)
    console.log("ONNX Runtime carregado com sucesso")
}

export async function testImagePreprocessing(){
    const imageUrl = chrome.runtime.getURL("assets/image/test.png")
    const image = await loadImage(imageUrl)

    if(image !== undefined){
        console.log("Imagem de teste carregada")
    }else{
        console.error("Imagem não foi carregada")
    }
    

    const result = preprocessImage(image)
    console.log("Tensor criado: ", result.tensor)
    console.log("Tensor dimensions: ", result.tensor.dims)
    console.log("Tensor type: ", result.tensor.type)
    console.log("Transform: ", result.transform)
    console.log("Primeiros valores: ", result.tensor.data.slice(0, 10))

    return {...result, image}
}

export async function testComicTextDetectorFile(){
    const modelUrl = chrome.runtime.getURL(MODEL_PATH)

    console.log("CTD URL: ", modelUrl)

    const response = await fetch(modelUrl)

    console.log("CTD HTTP status: ", response.status)

    if(!response.ok) throw new Error(`Não foi possivel carregar CTD: HTTP ${response.status}`)

    const buffer = await response.arrayBuffer()

    console.log("CTD carregado: ", buffer.byteLength, " bytes")

    return buffer
}

export async function loadComicTextDetector(){
    if(session){
        console.log("CTD já está carregado")
        return session
    }

    configureOnnxRuntime()

    const modelUrl = chrome.runtime.getURL(MODEL_PATH)

    console.log("Carregando CTD: ")
    console.log(modelUrl)

    const response = await fetch(modelUrl)

    if(!response.ok) throw new Error(`Falha carregando CTD: HTTP ${response.status}`)

    const modelBuffer = await response.arrayBuffer()

    console.log("Modelo lido: ", modelBuffer.byteLength, " byte")

    console.log("Criando InferenceSession...")

    session = await ort.InferenceSession.create(modelBuffer, {
        executionProviders: ["wasm"]
    })

    console.log("CTD carregado com sucesso")
    console.log("Inputs: ", session.inputNames)
    console.log("Outputs: ", session.outputNames)

    return session
}

export async function runComicTextDetector(tensor, transform){
    if(!session) throw new Error("Comic Text Detector ainda não foi carregado")

    const inputName = session.inputNames[0]

    console.time("CTD inference")

    const outputs = await session.run({ [inputName]: tensor })

    console.timeEnd("CTD inference")

    const boxes = decodeBlockOutput(outputs.blk, transform)

    console.log("TEXT BLOCKS: ", boxes)

    console.log("Executando CTD..")

    inspectOutputs(outputs)

    return {boxes, segmentation: outputs.seg, lineDetection: outputs.det}
}