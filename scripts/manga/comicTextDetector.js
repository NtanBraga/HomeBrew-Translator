import * as ort from "onnxruntime-web/wasm"

const MODEL_PATH = "models/comic-text-detector/comictextdetector.pt.onnx"

let session = null

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

export function testOnnxRuntime(){
    console.log("ONNX Runtime: ", ort)
    console.log("ONNX Runtime carregado com sucesso")
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
        return
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