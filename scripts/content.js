import { loadComicTextDetector, runComicTextDetector, cropTextBlocks, loadImage, preprocessImage, renderTranslationOverImage, createSegmentationMask, estimateBackgroundColor, measureBackgroundDeviation, analizeBlackgroundDominance, detectTextContainer, floodFillTextContainer, translationBoxFromFloodRegion, growFreeTextBox } from "./manga/comicTextDetector"

const OCR_DEBUG = {events: []}

let translationRunning = false
let translationGeneration = 0

const mangaOverlayController = new Map()

let mangaMutationObserver = null
let mangaProcessQueue = Promise.resolve()
let mangaImageSequence = 0

const waitingImages = new WeakSet()


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

//Deactivate translations

async function getMangaTranslationState(){
    const settings = await chrome.storage.local.get([
        "translationActive", "ocrMode"
    ])
    return {
        active: settings.translationActive === true,
        mode: settings.ocrMode || OCR_MODE.AUTO
    }
}

function clearMangaTranslations(){
    debugOCR("Removendo overlays do Homebrew Translator")

    for(const controller of mangaOverlayController.values()){
        try{
            controller.destroy()
        }catch(e){
            debugOCRError("Erro removendo overlay: ", e)
        }
    }
    mangaOverlayController.clear()

    document.querySelectorAll("[data-homebrew-ocr-status]").forEach(
        image => { delete image.dataset.homebrewOcrStatus }
    )
}

// png -> base64
async function recognizeMangaCrop(crop){
    const imageBase64 = crop.canvas.toDataURL("image/png")

    debugOCR(`Enviando crop ${crop.index} para Manga-OCR`)

    const response = await chrome.runtime.sendMessage({
        type: "MANGA_OCR",
        image: imageBase64
    })

    if(!response.ok) throw new Error(response?.error || "Manga OCR falhou")

    return response.text
}

async function recognizeAllMangaCrops(crops){
    const result = []

    let successCounts = 0

    for(const crop of crops){
        debugOCR(`OCR ${crop.index + 1}/${crops.length}`)

        try{
            const text = await recognizeMangaCrop(crop)

            successCounts++

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

    if(crops.length > 0 && successCounts == 0) throw new Error("Manga-OCR indisponivel: todos os crops falharam")

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

function isMangaImageCandidate(image){
    if(!(image instanceof HTMLImageElement)) return false

    const src = image.currentSrc || image.src

    if(!src) return false

    if(!src.startsWith("http://") && !src.startsWith("https://")) return false

    if(!image.complete) return false

    if(image.naturalWidth < 300 || image.naturalHeight < 300) return false

    const rect = image.getBoundingClientRect()
    if(rect.width <= 0 || rect.height <= 0) return false

    const status = image.dataset.homebrewOcrStatus

    if(status === "queued" || status === "processing" || status === "translated") return false

    return true

}

function enqueueMangaImage(imageElement){
    if(!isMangaImageCandidate(imageElement)) return

    const generation = translationGeneration
    const imageIndex = mangaImageSequence++
    
    imageElement.dataset.homebrewOcrStatus = "queued"

    debugOCR(`Imagem ${imageIndex} adicinada a fila`)

    mangaProcessQueue = mangaProcessQueue.then(async () => {
        if(generation !== translationGeneration) return

        const settings = await getMangaTranslationState()

        if(!settings.active || settings.mode !== OCR_MODE.MANGA) return

        if(imageElement.dataset.homebrewOcrStatus === "translated") return

        await processMangaImage(imageElement, imageIndex, generation)
    }).catch(error => {
        debugOCRError(`Erro na fila da imagem ${imageIndex}:`, error)
    })
}

function handlePotentialMangaImage(imageElement){
    if(!(imageElement instanceof HTMLImageElement)) return

    if(imageElement.complete && imageElement.naturalWidth > 0){
        enqueueMangaImage(imageElement)
        return
    }

    if(waitingImages.has(imageElement)) return

    waitingImages.add(imageElement)

    imageElement.addEventListener("load", () => {
        waitingImages.delete(imageElement)
        enqueueMangaImage(imageElement)
    }, { once: true })
}

function startMangaMutationObserver(){
    if(mangaMutationObserver) return

    debugOCR("Inicializando Iniciando observação de novas imagens")

    mangaMutationObserver = new MutationObserver(mutations => {
        for(const mutation of mutations){
            if(mutation.type === "childList"){
                for(const node of mutation.addedNodes){
                    if(!(node instanceof Element)) continue
                    if(node instanceof HTMLImageElement) handlePotentialMangaImage(node)

                    const images = node.querySelectorAll?.("img")

                    images?.forEach(handlePotentialMangaImage)
                }
            }
            if(mutation.type === "attributes" && mutation.target instanceof HTMLImageElement){
                handlePotentialMangaImage(mutation.target)
            }
        }
    })
    mangaMutationObserver.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["src", "srcset"]
    })
}

function stopMangaMutationObserver(){
    if(!mangaMutationObserver) return

    debugOCR("Parando observação de imagens")

    mangaMutationObserver.disconnect()

    mangaMutationObserver = null
}

function findPageImageCandidates(){
    const candidates = Array.from(document.images).filter(isMangaImageCandidate)

    candidates.sort((a,b) => {
        const areaA = a.naturalWidth * a.naturalHeight
        const areaB = b.naturalWidth * b.naturalHeight

        return areaB - areaA
    })
    return candidates
}

function dilateMaskCanvas(maskCanvas, radius = 2){
    const width = maskCanvas.width
    const height = maskCanvas.height

    const sourceContext = maskCanvas.getContext("2d", { willReadFrequently: true })
    const sourceData = sourceContext.getImageData(0, 0, width, height)

    const result = document.createElement("canvas")
    result.width = width
    result.height = height

    const resultContext = result.getContext("2d", { willReadFrequently: true })
    const resultData = resultContext.createImageData(width, height)

    for(let y = 0; y < height; y++){
        for(let x = 0; x < width; x++){
            const index = (y * width + x) * 4

            if(sourceData.data[index + 3] === 0) continue

            for(let dy = -radius; dy <= radius; dy++){
                for(let dx = -radius; dx <= radius; dx++){
                    if(dx * dx + dy * dy > radius * radius) continue

                    const nx = x + dx
                    const ny = y + dy

                    if(nx < 0 || ny < 0 || nx >= width || ny >= height) continue

                    const newIndex = (ny * width + nx) * 4

                    resultData.data[newIndex] = 255
                    resultData.data[newIndex + 1] = 255
                    resultData.data[newIndex + 2] = 255
                    resultData.data[newIndex + 3] = 255
                }
            }
        }
    }
    resultContext.putImageData(resultData, 0, 0)

    return result
}

function createInpaintRegion(image, dilatedMask, box, padding=8){

    const x1 = Math.max(0, Math.floor(box.x1 - padding))
    const y1 = Math.max(0, Math.floor(box.y1 - padding))
    const x2 = Math.min(image.naturalWidth, Math.ceil(box.x2 + padding))
    const y2 = Math.min(image.naturalHeight, Math.ceil(box.y2 + padding))

    const width = x2 - x1
    const height = y2 - y1

    const imageCanvas = document.createElement("canvas")
    imageCanvas.width = width
    imageCanvas.height = height

    const imageContext = imageCanvas.getContext("2d")

    if(!imageContext) throw new Error("Não foi possivel criar imageCanvas do inpaint")

    imageContext.drawImage(
        image,
        x1,
        y1,
        width,
        height,
        0,
        0,
        width,
        height
    )

    const maskCanvas = document.createElement("canvas")
    maskCanvas.width = width
    maskCanvas.height = height

    const maskContext = maskCanvas.getContext("2d")

    if(!maskContext) throw new Error("Não foi possivel criar maskCanvas do inpaint")

    maskContext.fillStyle = "black"
    maskContext.fillRect(0, 0, width, height)

    maskContext.drawImage(
        dilatedMask,
        x1,
        y1,
        width,
        height,
        0,
        0,
        width,
        height
    )

    return {
        imageCanvas,
        maskCanvas,
        crop: {
            x: x1,
            y: y1,
            width,
            height
        }
    }
}

function applyLocalEraseToImageData(restorationData, sourceData, maskData, imageWidth, imageHeight, item){
    const box = item.box

    const backgroundColor = estimateBackgroundColor(sourceData, maskData, imageWidth, imageHeight, box)

    const x1 = Math.max(0, Math.floor(box. x1))
    const y1 = Math.max(0, Math.floor(box. y1))
    const x2 = Math.min(imageWidth, Math.ceil(box. x2))
    const y2 = Math.min(imageHeight, Math.ceil(box. y2))

    for(let y = y1; y < y2; y++){
        for(let x = x1; x < x2; x++){
            const index = (y * imageWidth + x) * 4

            if(maskData.data[index + 3] === 0) continue

            restorationData.data[index] = backgroundColor.r
            restorationData.data[index + 1] = backgroundColor.g
            restorationData.data[index + 2] = backgroundColor.b
            restorationData.data[index + 3] = 255
        }
    }
}

async function requestMangaInpaint(imageCanvas, maskCanvas){
    const imageBase64 = imageCanvas.toDataURL("image/png")
    const maskBase64 = maskCanvas.toDataURL("image/png")

    const response = await chrome.runtime.sendMessage({
        type: "MANGA_INPAINT",
        image: imageBase64,
        mask: maskBase64
    })

    if(!response.ok) throw new Error(response?.error || "Manga inpainting falhou")

    return response.image
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

async function processMangaImage(imageElement, imageIndex, generation) {
    debugOCR(`Processando imagem ${imageIndex}`)

    try{
        imageElement.dataset.homebrewOcrStatus = "processing"

        const preprocess = await preparePageImage(imageElement)

        if(generation !== translationGeneration) return

        const detection = await runComicTextDetector(preprocess.tensor, preprocess.transform)

        if(generation !== translationGeneration) return

        debugOCR(`Imagem ${imageIndex}: `, detection.boxes.length, " blocos encontrados")

        if(detection.boxes.length === 0){
            imageElement.dataset.homebrewOcrStatus = "done"

            return
        }

        const crops = cropTextBlocks(preprocess.image, detection.boxes)
        const recognizedCrops = await recognizeAllMangaCrops(crops)

        if(generation !== translationGeneration) return

        const translatedCrops = await translateAllMangaCrops(recognizedCrops)

        const baseMask = createSegmentationMask(detection.segmentation, preprocess.transform, 0.5)
        const fillMask = dilateMaskCanvas(baseMask, 2)
        const inpaintMask = dilateMaskCanvas(baseMask,  4)

        const baseMaskContext = baseMask.getContext("2d", { willReadFrequently:true })
        if(!baseMaskContext) throw new Error("Não foi possivel ler basemask")
        const analysisMaskData = baseMaskContext.getImageData(0, 0, baseMask.width, baseMask.height)

        const fillMaskContext = fillMask.getContext("2d", { willReadFrequently: true })
        if(!fillMaskContext) throw new Error("Não foi possivel ler fillMask")
        const fillMaskData = fillMaskContext.getImageData(0, 0, fillMask.width, fillMask.height)

        const sourceCanvas = document.createElement("canvas")
        sourceCanvas.width = preprocess.image.naturalWidth
        sourceCanvas.height = preprocess.image.naturalHeight

        const sourceContext = sourceCanvas.getContext("2d", { willReadFrequently: true })

        sourceContext.drawImage(preprocess.image, 0, 0, sourceCanvas.width, sourceCanvas.height)

        const sourceData = sourceContext.getImageData(0, 0, sourceCanvas.width, sourceCanvas.height)

        const localItems = []
        const inpaintItems = []

        for(const item of translatedCrops){
            if(!item.translation?.trim()) continue

            if(generation !== translationGeneration) return

            const deviation = measureBackgroundDeviation(sourceData, analysisMaskData, sourceCanvas.width, sourceCanvas.height, item.box)

            const dominance = analizeBlackgroundDominance(sourceData, analysisMaskData, sourceCanvas.width, sourceCanvas.height, item.box)

            let backgroundType

            if(dominance.ratio >= 0.80 && deviation < 25){
                backgroundType = "uniform"
            }else if(dominance.ratio >= 0.60 || deviation < 25){
                backgroundType = "mixed"
            }else{
                backgroundType = "complex"
            }

            item.backgroundAnalysis = {
                deviation,
                dominantRatio: dominance.ratio,
                dominantColor: dominance.color,
                backgroundType
            }

            debugOCR(`Crop ${item.index} - analise: `, item.backgroundAnalysis)

            item.containerAnalysis = detectTextContainer(
                sourceData,
                analysisMaskData,
                sourceCanvas.width,
                sourceCanvas.height,
                item.box,
                item.backgroundAnalysis
            )

            debugOCR(`Crop ${item.index} - container: `, item.containerAnalysis)


            item.floodRegion = floodFillTextContainer(
                sourceData,
                analysisMaskData,
                sourceCanvas.width,
                sourceCanvas.height,
                item.box,
                item.backgroundAnalysis,
                item.containerAnalysis
            )

            debugOCR(`Crop ${item.index} - flood: `, item.floodRegion)

            const floodTranslationBox = translationBoxFromFloodRegion(item.floodRegion, item.box)

            if(floodTranslationBox){
                item.layoutType = "container"
                item.translationBox = floodTranslationBox
            }else{
                item.layoutType = "freeText"

                item.translationBox = growFreeTextBox(
                    sourceData,
                    analysisMaskData,
                    sourceCanvas.width,
                    sourceCanvas.height,
                    item.box,
                    item.backgroundAnalysis
                )
            }
            
            debugOCR(`Crop ${item.index} - translationBox: `, {
                layoutType: item.layoutType,
                source: floodTranslationBox ? "flood" : "freeTextGrow",
                original: item.box,
                expanded: item.translationBox
            })

            if(backgroundType === "uniform"){
                localItems.push(item)
            }else if(backgroundType === "mixed" && dominance.color.r > 220 && dominance.color.g > 220 && dominance.color.b > 220){
                localItems.push(item)
            }else{
                inpaintItems.push(item)
            }

        }

        const restorationCanvas = document.createElement("canvas")

        restorationCanvas.width = preprocess.image.naturalWidth
        restorationCanvas.height = preprocess.image.naturalHeight

        const restorationContext = restorationCanvas.getContext("2d")

        if(!restorationContext) throw new Error("Não foi possivel criar canvas final do inpainting")

        const restorationData = restorationContext.createImageData(restorationCanvas.width, restorationCanvas.height)


        for(const item of localItems){
            if(generation !== translationGeneration) return
            debugOCR(`Crop ${item.index}: preenchimento local`)
            applyLocalEraseToImageData(restorationData, sourceData, fillMaskData, restorationCanvas.width, restorationCanvas.height, item)
        }

        restorationContext.putImageData(restorationData, 0, 0)

        for(const item of inpaintItems){
            if(generation !== translationGeneration) return
            debugOCR(`Crop ${item.index}: inpainting`)

            const region = createInpaintRegion(preprocess.image, inpaintMask, item.box, 8)
            const inpaintResult = await requestMangaInpaint(region.imageCanvas, region.maskCanvas)
            
            if(generation !== translationGeneration) return

            const inpaintImage = await loadImage(inpaintResult)

            restorationContext.drawImage(inpaintImage, region.crop.x, region.crop.y, region.crop.width, region.crop.height)
        }

        if(generation !== translationGeneration) return

        const overlayController = await renderTranslationOverImage(imageElement, translatedCrops, restorationCanvas)

        mangaOverlayController.set(imageElement, overlayController)

        imageElement.dataset.homebrewOcrStatus = "translated"
        
        debugOCR(`Imagem ${imageIndex} concluida`)

    }catch(e){
        imageElement.dataset.homebrewOcrStatus = "error"

        debugOCRError(`Erro processando imagem ${imageIndex}`, e)
    }
}
//init

async function startMangaTranslation(){
    if(translationRunning){
        debugOCR("Tradução já está em execução")
        return
    }

    const settings = await getMangaTranslationState()
    
    if(!settings.active || settings.mode !== OCR_MODE.MANGA){
        debugOCR("Modo Manga não esta ativo")
        return
    }

    translationRunning = true

    const generation = ++ translationGeneration

    try{
        debugOCR("Iniciando modo manga")

        const session = await loadComicTextDetector()

        if(generation !== translationGeneration) return

        debugOCR("CTD pronto:", session.inputNames)

        startMangaMutationObserver()

        const candidates = findPageImageCandidates()

        debugOCR("Imagens candidatas: ", candidates.length)

        for(const image of candidates){
            enqueueMangaImage(image)
        }

        debugOCR("Processamento Manga concluido.")
    }catch(e){
        debugOCRError("Erro no modo Manga: ", e)
    }finally{
        translationRunning = false
    }
}

function stopMangaTranslation(){
    debugOCR("Parando modo Manga")

    translationGeneration++

    translationRunning = false

    stopMangaMutationObserver()

    mangaProcessQueue = Promise.resolve()

    clearMangaTranslations()
}

chrome.storage.onChanged.addListener(
    async (changes, areaName) => {

        if(areaName !== "local") return


        const translationChanged = "translationActive" in changes

        const modeChanged = "ocrMode" in changes


        if(!translationChanged && !modeChanged) return

        const settings = await getMangaTranslationState()

        debugOCR("Configuração mudou: ", settings)

        if(settings.active && settings.mode === OCR_MODE.MANGA){
            await startMangaTranslation()
        }else{
            stopMangaTranslation()
        }

    }
)

async function initialize(){
    debugOCR("Iniciando content.js")

    const settings = await getMangaTranslationState()

    debugOCR("Estado inicial: ", settings)

    if(settings.active && settings.mode === OCR_MODE.MANGA) await startMangaTranslation()
}

initialize().catch(error => {
    debugOCRError("Erro inicializando Homebrew Translator: ", error)
})


