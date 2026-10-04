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

function sigmoid(value){
    return 1 / (1 + Math.exp(-value))
}

function median(values){
    if(values.length === 0) return 255

    values.sort((a,b) => a - b)

    return values[Math.floor(values.length / 2)]
}

export function estimateBackgroundColor(sourceData, maskData, imageWidth, imageHeight, box){
    const reds = []
    const greens = []
    const blues = []

    const x1 = Math.max(0, Math.floor(box.x1))
    const y1 = Math.max(0, Math.floor(box.y1))
    const x2 = Math.min(imageWidth, Math.ceil(box.x2))
    const y2 = Math.min(imageHeight, Math.ceil(box.y2))

    const sampleStep = 2

    for(let y = y1; y < y2; y += sampleStep){
        for(let x = x1; x < x2; x += sampleStep){
            const index = (y * imageWidth + x) * 4
            const maskAlpha = maskData.data[index + 3]

            if(maskAlpha > 0) continue

            const red = sourceData.data[index]
            const green = sourceData.data[index + 1]
            const blue = sourceData.data[index + 2]

            reds.push(red)
            greens.push(green)
            blues.push(blue)
        }
    }

    if(reds.length === 0){
        return {
            r: 255,
            g: 255,
            b: 255
        }
    }
    return {
        r: median(reds),
        g: median(greens),
        b: median(blues)
    }
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

export function createSegmentationMask(segmentationTensor, transform, threshold = 0.5){
    const dims = segmentationTensor.dims
    const data = segmentationTensor.data

    if(dims.length !== 4 || dims[0] !== 1 || dims[1] !== 1){
        throw new Error(`Formato de segmentation inesperado: ${dims}`)
    }

    const height = dims[2]
    const width = dims[3]

    let minValue = Infinity
    let maxValue = -Infinity

    for(let i = 0; i < data.length; i++){
        const value = data[i]

        if(value < minValue) minValue = value
        if(value > maxValue) maxValue = value
        
    }

    console.log(`Segmentation range: `, {minValue, maxValue})

    const useSigmoid = minValue < 0 || maxValue > 1
    const modelCanvas = document.createElement("canvas")

    modelCanvas.width = width
    modelCanvas.height = height

    const context = modelCanvas.getContext("2d")

    if(!context) throw new Error("Não foi possivel criar canvas da mascara")

    const imageData = context.createImageData(width, height)

    for(let i = 0; i < data.length; i++){
        let probability = data[i]

        if(useSigmoid){
            probability = sigmoid(probability)
        }

        const pixelIndex = i * 4

        if(probability >= threshold){

            imageData.data[pixelIndex] = 255
            imageData.data[pixelIndex + 1] = 0
            imageData.data[pixelIndex + 2] = 0
            imageData.data[pixelIndex + 3] = 180
        }else{
            imageData.data[pixelIndex + 3] = 0
        }
    }
    context.putImageData(imageData, 0, 0)

    const originalCanvas = document.createElement("canvas")

    originalCanvas.width = transform.originalWidth
    originalCanvas.height = transform.originalHeight

    const originalContext = originalCanvas.getContext("2d")

    if(!originalContext) throw new Error("Não foi possivel criar canvas original da mascara")

    originalContext.imageSmoothingEnabled = false
    originalContext.drawImage(
        modelCanvas,
        //source
        0,
        0,
        transform.resizedWidth,
        transform.resizedHeight,
        //destination
        0,
        0,
        transform.originalWidth,
        transform.originalHeight
    )
    return originalCanvas
}

export function showSegmentationDebug(image, segmentationTensor, transform){
    const mask = createSegmentationMask(segmentationTensor, transform, 0.5)
    const canvas = document.createElement("canvas")

    canvas.width = image.naturalWidth
    canvas.height = image.naturalHeight

    const context = canvas.getContext("2d")

    if(!context) throw new Error("Não foi possivel criar debug da segmentation")

    context.drawImage(
        image,
        0,
        0,
        canvas.width,
        canvas.height
    )
    context.drawImage(
        mask,
        0,
        0
    )

    canvas.style.position = "fixed"
    canvas.style.right = "10px"
    canvas.style.top = "10px"
    canvas.style.maxWidth = "50vw"
    canvas.style.maxHeight = "90vh"
    canvas.style.width = "auto"
    canvas.style.height = "auto"
    canvas.style.zIndex = "205"
    canvas.style.border = "2px solid black"

    document.body.appendChild(canvas)

    return canvas
}

export function loadImage(url){
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

export function preprocessImage(image){
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

//crop text blocks

export function cropTextBlocks(image, boxes){
    const crops = []

    boxes.forEach((box, index) => {
        const boxWidth = box.x2 - box.x1
        const boxHeight = box.y2 - box.y1

        const padding = Math.max(4, Math.round(Math.min(boxWidth, boxHeight) * 0.05))
        const x1 = Math.max(0, Math.floor(box.x1 - padding))
        const y1 = Math.max(0, Math.floor(box.y1 - padding))
        const x2 = Math.min(image.naturalWidth, Math.ceil(box.x2 + padding))
        const y2 = Math.min(image.naturalHeight, Math.ceil(box.y2 + padding))

        const width = x2 - x1
        const height = y2 - y1

        if(width <= 0 || height <= 0) return

        const canvas = document.createElement("canvas")
        canvas.width = width
        canvas.height = height

        const context = canvas.getContext("2d")

        if(!context) throw new Error("Não foi possivel criar canvas para crop")

        context.drawImage(
            image,
            //source
            x1,
            y1,
            width,
            height,
            //destination
            0,
            0,
            width,
            height
        )

        crops.push({
            index,
            canvas,
            box,
            crop: {
                x: x1,
                y: y1,
                width,
                height
            }
        })
    })
    return crops
}

export function showDebugCrops(crops){
    const container = document.createElement("div")

    container.style.position = "fixed"
    container.style.left = "10px"
    container.style.top = "10px"
    container.style.maxHeight = "90vh"
    container.style.width = "260px"
    container.style.overflowY = "auto"
    container.style.background = "white"
    container.style.border = "2px solid black"
    container.style.padding = "8px"
    container.style.zIndex = 201

    crops.forEach(item => {
        const wrapper = document.createElement("div")
        wrapper.style.marginBottom = "12px"
        const title = document.createElement("div")
        title.textContent = `Block ${item.index} - ${(item.box.confidence * 100).toFixed(1)}%`
        title.style.color = "black"
        title.style.fontSize = "14px"
        
        item.canvas.style.maxWidth = "100%"
        item.canvas.style.height = "auto"
        item.canvas.style.border = "1px solid #999"

        wrapper.appendChild(title)
        wrapper.appendChild(item.canvas)

        container.appendChild(wrapper)
    })
    document.body.appendChild(container)

    return container
}

//visual translation

function fitTextToBox(element, maxFontSize = 24, minFontSize = 6){
    let min = minFontSize
    let max = maxFontSize
    let best = null

    while(min <= max){
        const size = Math.floor((min + max) / 2)

        element.style.fontSize = `${size}px`

        const fitsWidth = element.scrollWidth <= element.clientWidth 
        const fitsHeight = element.scrollHeight <= element.clientHeight

        if(fitsHeight && fitsWidth){
            best = size
            min = size + 1
        }else{
            max = size - 1
        }
    }

    if(best !== null){
        element.style.fontSize = `${best}px`
        
        return {
            fits: true,
            fontSize: best
        }
    }

    element.style.fontSize = `${minFontSize}px`

    return {
        fits: false,
        fontSize: minFontSize
    }
}

export function showTranslationPreview(image, translatedCrops){
    const viewport = document.createElement("div")

    viewport.style.position = "fixed"
    viewport.style.top = "10px"
    viewport.style.right = "10px"
    viewport.style.maxWidth = "60vw"
    viewport.style.maxHeight = "95vh"
    viewport.style.overflow = "auto"
    viewport.style.background = "white"
    viewport.style.border = "2px solid black"
    viewport.style.zIndex = "202"

    const wrapper = document.createElement("div")

    wrapper.style.position = "relative"
    wrapper.style.width = `${image.naturalWidth}px`
    wrapper.style.height = `${image.naturalHeight}px`

    const imageElement = document.createElement("img")

    imageElement.src = image.src

    imageElement.style.position = "absolute"
    imageElement.style.left = "0"
    imageElement.style.top = "0"
    imageElement.style.width = `${image.naturalWidth}px`
    imageElement.style.height = `${image.naturalHeight}px`

    wrapper.appendChild(imageElement)
    viewport.appendChild(wrapper)
    document.body.appendChild(viewport)

    translatedCrops.forEach(item => {
        if(!item.translation?.trim()) return

        const box = item.box
        const overlay = document.createElement("div")

        overlay.textContent = item.translation
        
        overlay.style.position = "absolute"
        overlay.style.left = `${box.x1}px`
        overlay.style.top = `${box.y1}px`
        overlay.style.width = `${box.width}px`
        overlay.style.height = `${box.height}px`
        overlay.style.boxSizing = "border-box"
        overlay.style.padding = "4px"
        overlay.style.background = "rgba(255, 255, 255, 0.92)"
        overlay.style.border = "1px solid red"
        overlay.style.color = "black"
        overlay.style.display = "flex"
        overlay.style.alignItems = "center"
        overlay.style.justifyContent = "center"
        overlay.style.textAlign = "center"
        overlay.style.whiteSpace = "normal"
        overlay.style.overflowWrap = "break-word"
        overlay.style.wordBreak = "normal"
        overlay.style.overflow = "hidden"
        overlay.style.fontFamily = "Arial, sans-serif"
        overlay.style.lineHeight = "1.1"
        overlay.style.pointerEvents = "none"

        wrapper.appendChild(overlay)
        const fitting = fitTextToBox(overlay, 24, 6)

        console.log(`Crop ${item.index}: `, fitting)
    })

    return viewport
}

export function renderTranslationOverImage(imageElement, translatedCrops, eraseCanvas){

    const oldLayer = imageElement.__homebrewTranslationLayer

    if(oldLayer) oldLayer.remove()

    const layer = document.createElement("div")
    layer.className = "homebrew-translation-layer"

    layer.style.position = "absolute"
    layer.style.pointerEvents = "none"
    layer.style.zIndex = "204"

    document.body.appendChild(layer)

    if(eraseCanvas){
        eraseCanvas.className = "homebrew-text-erase-layer"
        eraseCanvas.style.position = "absolute"
        eraseCanvas.style.left = "0"
        eraseCanvas.style.top = "0"
        eraseCanvas.style.width = "100%"
        eraseCanvas.style.height = "100%"
        eraseCanvas.style.pointerEvents = "none"
        eraseCanvas.style.zIndex = "0"

        layer.appendChild(eraseCanvas)
    }

    const overlays = []

    translatedCrops.forEach(item => {
        if(!item.translation?.trim()) return

        const overlay = document.createElement("div")

        overlay.textContent = item.translation
        overlay.style.position = "absolute"
        overlay.style.boxSizing = "border-box"
        overlay.style.padding = "3px"
        overlay.style.background = "transparent"
        overlay.style.border = "1px solid red"
        overlay.style.color = "black"
        overlay.style.display = "flex"
        overlay.style.alignItems = "center"
        overlay.style.justifyContent = "center"
        overlay.style.textAlign = "center"
        overlay.style.whiteSpace = "normal"
        overlay.style.overflowWrap = "break-word"
        overlay.style.wordBreak = "normal"
        overlay.style.overflow = "hidden"
        overlay.style.fontFamily = "Arial, sans-serif"
        overlay.style.lineHeight = "1.1"

        //layer.appendChild(overlay)

        overlays.push({element: overlay, item})
    })

    function syncOverlay(){
        const rect = imageElement.getBoundingClientRect()

        if(rect.width <= 0 || rect.height <= 0){
            layer.style.display = "none"
            return
        }

        layer.style.display = "block"
        layer.style.left = `${rect.left + window.scrollX}px`
        layer.style.top = `${rect.top + window.scrollY}px`
        layer.style.width = `${rect.width}px`
        layer.style.height = `${rect.height}px`


        const scaleX = rect.width / imageElement.naturalWidth
        const scaleY = rect.height / imageElement.naturalHeight

        overlays.forEach(({element, item}) => {
            const box = item.box

            element.style.left = `${box.x1 * scaleX}px`
            element.style.top = `${box.y1 * scaleY}px`
            element.style.width = `${box.width * scaleX}px`
            element.style.height = `${box.height * scaleY}px`

            fitTextToBox(element, 24, 6)

        })
    }

    let syncSchedule = false
    function scheduleSync(){
        if(syncSchedule) return

        syncSchedule = true

        requestAnimationFrame(() => {
            syncSchedule = false
            syncOverlay()
        })
    }

    const resizeObserver = new ResizeObserver(() => {scheduleSync()})

    resizeObserver.observe(imageElement)
    window.addEventListener("resize", scheduleSync)
    window.addEventListener("scroll", scheduleSync, {passive: true})

    syncOverlay()

    imageElement.__homebrewTranslationLayer = layer

    function destroy(){
        resizeObserver.disconnect()

        window.removeEventListener("resize", scheduleSync)
        window.removeEventListener("scroll", scheduleSync)

        layer.remove()

        if(imageElement.__homebrewTranslationLayer === layer) delete imageElement.__homebrewTranslationLayer
    }

    return {layer, resizeObserver, syncOverlay, destroy}
}
