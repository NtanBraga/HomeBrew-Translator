import { testOnnxRuntime, testComicTextDetectorFile, loadComicTextDetector, testImagePreprocessing, runComicTextDetector, drawDebugBoxes, cropTextBlocks, showDebugCrops, showTranslationPreview, loadImage, preprocessImage, renderTranslationOverImage } from "./manga/comicTextDetector"

const OCR_DEBUG = {events: []}


function debugOCR(label, value){
    
    if(value !== undefined){
        console.log(`[OCR DEBUG] ${label}`, value)
    }else{
        console.log(`[OCR DEBUG] ${label}`)
    }

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
    if(error !== undefined){
        console.log(`[OCR ERROR] ${label}`, error)
    }else{
        console.log(`[OCR ERROR] ${label}`)
    }

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

// png -> base64
async function recognizeMangaCrop(crop){
    const imageBase64 = crop.canvas.toDataURL("image/png")

    console.log(`Enviando crop ${crop.index} para Manga-OCR`)

    const response = await chrome.runtime.sendMessage({
        type: "MANGA_OCR",
        image: imageBase64
    })

    if(!response.ok) throw new Error(response?.error || "Manga OCR falhou")

    return response.text
}

async function recognizeAllMangaCrops(crops){
    const result = []

    for(const crop of crops){
        debugOCR(`OCR ${crop.index + 1}/${crops.length}`)

        try{
            const text = await recognizeMangaCrop(crop)

            debugOCR(`Crop ${crop.index}: `, text)

            result.push({
                ...crop,
                text
            })
        }catch(e){
            debugOCRError(`Erro OCR crop ${crop.index}: `, e)
            result.push({
                ...crop,
                text: "",
                ocrError: e?.message || String(e)
            })
        }
    }
    return result
}

//Detect - Translate

async function transalteMangaText(text, sourceLanguage,targetLanguage){
    const response = await chrome.runtime.sendMessage({
        type:"OLLAMA_TRANSLATE",
        payload: {
            text,
            sourceLanguage,
            targetLanguage,
            lowConfidenceWords: [],
            context: ""
        }
    })

    if(!response?.ok) throw new Error(response?.error || "Falha na tradução com Ollama")

    return response.result
}

async function getTranslationSettings(){
    const settings = await chrome.storage.local.get([
        "langFrom", "langTo"
    ])

    return {
        sourceLanguage: settings.langFrom || "jpn",
        targetLanguage: settings.langTo || "eng"
    }
}

async function translateAllMangaCrops(recognizedCrops) {
    const {sourceLanguage, targetLanguage} = await getTranslationSettings()

    const results = []

    for(let i = 0; i < recognizedCrops.length; i++){
        const item = recognizedCrops[i]

        debugOCR(`Traduzindo ${i + 1}/${recognizedCrops.length}`, item.text)

        if(!item.text?.trim()){
            results.push({
                ...item,
                correctedText: "",
                translation: "",
                corrections: []
            })
            continue
        }

        try{
            const translationResult = await transalteMangaText(item.text, sourceLanguage, targetLanguage)
            debugOCR(`Tradução crop ${item.index}`, translationResult)

            results.push({
                ...item,
                correctedText: translationResult.correctedText,
                translation: translationResult.translation,
                corrections: translationResult.corrections || []
            })
        }catch(e){
            debugOCRError(`Erro traduzindo crop ${item.index}`, e)

            results.push({
                ...item,
                correctedText: item.text,
                translation: "",
                corrections: [],
                translationError: e?.message || String(e)
            })
        }
    }
    return results
}

// find image candidate

function findPageImageCandidates(){
    const images = Array.from(document.images)
    const candidates = images.filter(image => {
        const src = image.currentSrc || image.src

        if(!src) return false
        if(!src.startsWith("http://") && !src.startsWith("https://")) return false
        if(!image.complete) return false
        if(image.naturalWidth < 300 || image.naturalHeight < 300) return false

        const rect = image.getBoundingClientRect()
        if(rect.width <= 0 || rect.height <= 0) return false

        return true
    })

    candidates.sort((a,b) => {
        const areaA = a.naturalWidth * a.naturalHeight
        const areaB = b.naturalWidth * b.naturalHeight

        return areaB - areaA
    })
    return candidates
}

async function fetchPageImageasDataUrl(imageElement){
    const url = imageElement.currentSrc || imageElement.src
    const response = await chrome.runtime.sendMessage({
        type: "FETCH_IMAGE_FOR_OCR",
        url
    })

    if(!response?.ok){
        throw new Error(response?.error || `Não foi possivel buscar imagem: ${url}`)
    }

    return response.dataUrl
}

async function preparePageImage(imageElement){
    const dataUrl = await fetchPageImageasDataUrl(imageElement)
    const image = await loadImage(dataUrl)
    const preprocess = preprocessImage(image)

    return{
        imageElement,
        image,
        ...preprocess
    }
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

loadComicTextDetector().then(async session => {
    debugOCR("CTD pronto: ", session.inputNames)

    const candidates = findPageImageCandidates()

    console.log("Quantidade de candidatos: ", candidates.length)

    if(candidates.length === 0)throw new Error("Nenhuma imagem candidata encontrada na pagina")

    const pageImage = candidates[0]

    debugOCR("Imagens candidatas: ",
        candidates.map((image, index) => ({
            index,
            src: image.currentSrc || image.src,
            naturalWidth: image.naturalWidth,
            naturalHeight: image.naturalHeight,
            displayedWidth: image.clientWidth,
            displayedHeight: image.clientHeight
        }))
    )

    // const preprocess = await testImagePreprocessing()
    const preprocess = await preparePageImage(pageImage)
    debugOCR("Pre-processamento concluido: ", preprocess)
    
    const detection = await runComicTextDetector(preprocess.tensor, preprocess.transform)
    debugOCR("Inferência concluida: ", detection.boxes)

    const crops = cropTextBlocks(preprocess.image, detection.boxes)
    console.log("Crops criados: ", crops.length)

    const recognizedCrops = await recognizeAllMangaCrops(crops)
    debugOCR("OCR dos crops concluidos: ",
        recognizedCrops.map(item => ({
            index: item.index,
            text: item.text,
            confidence: item.box.confidence
        }))
    ) 

    const translatedCrops = await translateAllMangaCrops(recognizedCrops)
    debugOCR("Traduções concluidas: ",
        translatedCrops.map(item => ({
            index: item.index,
            original: item.text,
            corrected: item.correctedText,
            translation: item.translation,
            corrections: item.corrections
        }))
    )

    renderTranslationOverImage(pageImage, translatedCrops)

    //showTranslationPreview(preprocess.image, translatedCrops)


    //showDebugCrops(crops)

    // const debugCanvas = drawDebugBoxes(preprocess.image, detection.boxes)

    // debugCanvas.style.position = "fixed"
    // debugCanvas.style.top = "10px"
    // debugCanvas.style.right = "10px"
    // debugCanvas.style.maxWidth = "50vw"
    // debugCanvas.style.maxHeight = "90vh"
    // debugCanvas.style.width = "auto"
    // debugCanvas.style.height = "auto"
    // debugCanvas.style.zIndex = "200"
    // debugCanvas.style.border = "2px solid black"

    // document.body.appendChild(debugCanvas)

}).catch(error => {
    debugOCRError("Erro: ", error)
})




