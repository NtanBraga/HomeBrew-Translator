import { testOnnxRuntime, testComicTextDetectorFile, loadComicTextDetector } from "./manga/comicTextDetector"

const OCR_DEBUG = {events: []}


function debugOCR(label, value){
    let snapshot = value

    try{
        snapshot = structuredClone(value)
    }catch(e){
        try{
            snapshot = JSON.parse(JSON.stringify(value))
        }catch(e2){
            snapshot = String(value)
        }
    }

    OCR_DEBUG.events.push({
        time: new Date().toISOString(),
        label,
        value: snapshot
    })
}

function debugOCRError(label,error){
    console.error(label, error)

    OCR_DEBUG.events.push({
        time: new Date().toISOString(),
        label,
        error: {
            name: error?.name,
            message: error?.message || String(error),
            stack: error?.stack
        }
    })
}

function saveOCRDebugJSON(){
    const json = JSON.stringify(OCR_DEBUG, null, 2)

    const blob = new Blob([json], {
        type: "application/json;charset=utf-8"
    })
    const url = URL.createObjectURL(blob)
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
    const filename = `ocr-debug-${timestamp}.json`
    const link = document.createElement("a")
    link.href = url
    link.download = filename
    link.style.display = "none"
    document.documentElement.appendChild(link)
    link.click()
    link.remove()

    setTimeout(() => {
        URL.revokeObjectURL(url)
    }, 1000)
}

function installDebugAlias(){
    if(document.getElementById("__homebrew_debug_alias__")) return

    const script = document.createElement("script")

    script.id = "__homebrew_debug_alias__"
    script.src = chrome.runtime.getURL("scripts/debug.js")
    script.onload = () => {script.remove()}
    document.documentElement.appendChild(script)
}

document.addEventListener("__SAVE_OCR_DEBUG__", () => {saveOCRDebugJSON()})

installDebugAlias()

const OCR_MODE = {
    AUTO: "auto",
    MANGA: "manga",
    DOCUMENT: "document"
}

// ComicTextDetector && onnxRunTime config

debugOCR("Iniciando content.js")

testOnnxRuntime()

debugOCR("Passou de testOnnxRuntime")

testComicTextDetectorFile().then(() => {
    debugOCR("Comic Text Detector encontrado com sucesso")
}).catch(error => {
    debugOCRError("Erro carregando Comic Text Detector: ", error)
})

loadComicTextDetector().then(session => {
    debugOCR("Comic Text Detector pronto")
    debugOCR("Input: ", session.inputNames)
    debugOCR("Output: ", session.outputNames)
}).catch(error => {
    debugOCRError("Erro inicializando CTD: ", error)
})



