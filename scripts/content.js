import Tesseract from "tesseract.js";

//overlay que acompanha a imagem apos redimencionamento


const imageOverlay = new Map()

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

function updateOverlayPosition(imgElement, overlay){
    const rect = imgElement.getBoundingClientRect()

    overlay.style.left = `${rect.left}px`
    overlay.style.top = `${rect.top}px`
    overlay.style.width = `${rect.width}px`
    overlay.style.height = `${rect.height}px`

    const visible = rect.bottom > 0 && 
        rect.right > 0 &&
        rect.top < window.innerHeight &&
        rect.left < window.innerWidth 

    overlay.style.display = visible ? "block" : "none"
    
}

function removeImageOverlay(imgElement) {
    const data = imageOverlay.get(imgElement)

    if(!data) return

    data.resizeObserver.disconnect()

    window.removeEventListener("scroll", data.updatePosition, true)

    window.removeEventListener("resize", data.updatePosition)

    data.overlay.remove()

    imageOverlay.delete(imgElement)
}

function createImageOverlay(imgElement){
    removeImageOverlay(imgElement)

    const overlay = document.createElement("div")

    overlay.className = "ocr-translation-overlay"

    overlay.style.cssText = `
        position: fixed !important;
        z-index: 201 !important;
        pointer-events: none !important;
        padding: 0 !important;
        margin: 0 !important;
        border: none !important;
        box-sizing: border-box !important;
    `

    document.body.appendChild(overlay)

    updateOverlayPosition(imgElement, overlay)

    const resizeObserver = new ResizeObserver(() => {
        updateOverlayPosition(imgElement, overlay)
    })

    resizeObserver.observe(imgElement)

    const updatePosition = () => {
        updateOverlayPosition(imgElement, overlay)
    }

    window.addEventListener("scroll", updatePosition, true)
    window.addEventListener("resize", updatePosition)

    imageOverlay.set(imgElement,{overlay, resizeObserver, updatePosition})

    return overlay
}

function removeAllTranslationOverlays(){
    for(const imgElement of imageOverlay.keys()){
        removeImageOverlay(imgElement)
    }
}

//Obj: deixar o algoritmo decidir o modo do OCR com base 
// nos calculos de geometria da posição das palavras na foto
// podendo ter a certeza de ser documento ou manga

const OCR_MODE = {
    AUTO: "auto",
    MANGA: "manga",
    DOCUMENT: "document"
}

const VERTICAL_LANGUAGE_MAP = {
    jpn: "jpn_vert",
    kor: "kor_vert",
    chi_sim: "chi_sim_vert",
    chi_tra: "chi_tra_vert"
}

const CJK_LANGUAGES = new Set([
    "jpn",
    "jpn_vert",
    "kor",
    "kor_vert",
    "chi_sim",
    "chi_sim_vert",
    "chi_tra",
    "chi_tra_vert"
])
//pontuações com caracteres CJK
const CJK_PUNCTUATION = new Set([
    "。",
    "、",
    "！",
    "？",
    "「",
    "」",
    "『",
    "』",
    "…",
    "ー",
    "〜",
    "～"
])

const NO_SPACE_LANGUAGES = new Set([
    "jpn",
    "jpn_vert",
    "chi_sim",
    "chi_sim_vert",
    "chi_tra",
    "chi_tra_vert"
])

const OCR_WORKERS = new Map()

function normalizeOCRMode(mode){
    switch(mode){
        case OCR_MODE.MANGA: return OCR_MODE.MANGA
        case OCR_MODE.DOCUMENT: return OCR_MODE.DOCUMENT
        default: return OCR_MODE.AUTO
    }
}

function isExplicitVerticalLanguage(language) {
    return (language?.endsWith("_vert") === true)
}

function getPreferredOrientation(language){
    return isExplicitVerticalLanguage(language) ? "vertical" : "horizontal"
}

function usesNoWordSpaces(language){
    return NO_SPACE_LANGUAGES.has(language)
}

function isProbablyOCRNoise(word,selectedLang){
    const text = word.text?.trim() || ""
    const confidence = Number(word.confidence) || 0

    if(!text) return true

    const cjk = isCJKLanguage(selectedLang)

    const hasLetterOrNumber = /[\p{L}\p{N}]/u.test(text)

    const onlySymbols = /^[\p{P}\p{S}_]+$/u.test(text)

    if(cjk){
        if(CJK_PUNCTUATION.has(text)) return false

        if(hasLetterOrNumber) return false
        
        if(onlySymbols && confidence < 55) return true

        return false
    }

    if(confidence < 10) return true

    if(onlySymbols && confidence < 85) return true
    if(!hasLetterOrNumber && confidence < 90) return true

    const symbols = text.match(/[\p{P}\p{S}_]/gu) || []

    const symbolRatio = symbols.length / Math.max(text.length, 1)

    if(text.length <= 4 && symbolRatio >= 0.5 && confidence < 75) return true

    const suspeciousShortCode = /^[A-Za-z]\d{1,3}$/.test(text)

    if(suspeciousShortCode && confidence < 45) return true

    return false
}

function isHardNoiseRegion(region, selectedLang){
    const text = region.text?.trim() || ""

    if(!text) return true

    const chars = [...text].filter(char => !/\s/u.test(char))
    const meaningful = chars.filter(char => /[\p{L}\p{N}]/u.test(char))

    if(meaningful.length === 0) return true

    const confidence = Number(region.confidence) || 0

    if(meaningful.length === 1 && confidence < 10) return true

    return false
}

function getBaseLanguage(language){
    return language.replace(/_vert$/,"")
}

function getRefinementLanguage(selectedLang, orientation){
    const baseLang = getBaseLanguage(selectedLang)

    if(orientation === "vertical" && VERTICAL_LANGUAGE_MAP[baseLang]){
        return VERTICAL_LANGUAGE_MAP[baseLang]
    }

    return baseLang
}

function normalizeOCRText(text, selectedLang){
    if(!text) return ""

    let normalized = text.replace(/\r/g, "").trim()

    if(usesNoWordSpaces(selectedLang)){
        return normalized.replace(/\s+/g, "")
    }

    return normalized.replace(/\s*\n+\s*/g, " ").replace(/[ \t]+/g, " ").trim()
}

function shouldUseRefinedOCR(region,refined,selectedLang){
    if(!refined.text) return false

    if(refined.preprocessing === "first-pass") return false

    if(Number.isFinite(refined.score) && Number.isFinite(refined.firstPassScore)){
        return (refined.score >= refined.firstPassScore + 3)
    }

    return (refined.confidence >= region.confidence)
}

function estimateRegionCharacterSize(region){
    const words = region.lines?.flatMap(line => line.words || []) || []

    const sizes = words.map(word => {
        const width = bboxWidth(word.bbox)
        const height = bboxHeight(word.bbox)
        return Math.min(width, height)
    }).filter(size => Number.isFinite(size) && size > 2)

    if(sizes.length) return median(sizes)

    return 16
}

function createRefinementRectangle(region, imgElement, orientation = region.orientation){

    const bbox = region.bbox

    const charSize = estimateRegionCharacterSize(region)

    let horizontalPadding = Math.max(5, Math.round(charSize * 0.75))
    let verticalPadding = horizontalPadding

    if(orientation !== region.orientation){
        if(orientation === "vertical"){
            verticalPadding = Math.round(charSize * 4)
            horizontalPadding = Math.round(charSize * 1.5)
        }else{
            horizontalPadding = Math.round(charSize * 4)
            verticalPadding = Math.round(charSize * 1.5)
        }
    }
    if(orientation === "vertical") {
        verticalPadding = Math.max(verticalPadding, Math.round(charSize * 1.5))
    }else{
        horizontalPadding = Math.max(horizontalPadding, Math.round(charSize * 1.5))
    }

    const left = Math.max(0, Math.floor(bbox.x0 - horizontalPadding))
    const top = Math.max(0, Math.floor(bbox.y0 - verticalPadding))
    const right = Math.min(imgElement.naturalWidth, Math.ceil(bbox.x1 + horizontalPadding))
    const bottom = Math.min(imgElement.naturalHeight, Math.ceil(bbox.y1 + verticalPadding))

    return {left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top)}
}

function isProbablyMangaNoiseRegion(region, selectedLang){
    const text = region.text?.trim() || ""

    if(!text) return true
    
    const confidence = Number(region.confidence) || 0

    const chars = [...text].filter(char => !/\s/u.test(char))
    const meaningfulChars = chars.filter(char => /[\p{L}\p{N}]/u.test(char))

    if(isCJKLanguage(selectedLang)){
        const cjkChars = meaningfulChars.filter(char =>
            /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(char)
        )
    

        const latinChars = meaningfulChars.filter(char =>
            /[A-Za-z]/.test(char)
        )

        const supportCount = Number(region.ocrSupportCount) || 1
        const wasRefined = region.refined === true

        if(confidence < 35 && supportCount < 2 && !wasRefined) return true
        
        if(cjkChars.length <= 3 && confidence < 45 && supportCount < 2) return true
        
        if(wasRefined && confidence < 25) return true

        if(meaningfulChars.length === 0) return true

        if(confidence < 20) return true

        if(chars.length <= 2 && confidence < 55) return true

        if(cjkChars.length === 0 && latinChars.length > 0 && chars.length <= 4 && confidence < 85) return true

        if(meaningfulChars.length <= 5 && cjkChars.length > 0 && latinChars.length > 0){
            const cjkRatio = cjkChars.length / meaningfulChars.length

            if(cjkRatio < 0.70 && confidence < 80) return true

        }
        return false
    }

    if(text.length <= 4 && confidence < 35) return true

    const hasLetterOrNumber = /[\p{L}\p{N}]/u.test(text)

    if(!hasLetterOrNumber && region.confidence < 85) return true

    return false

}

function isProbablyDocumentNoiseRegion(region, selectedLang){
    const text = region.text?.trim() || ""

    if(!text) return true
    
    const confidence = Number(region.confidence) || 0
    
    const meaningful = [...text].filter(char => /[\p{L}\p{N}]/u.test(char))

    if(meaningful.length === 0) return true

    if(confidence < 10) return true

    if(meaningful.length === 1 && confidence < 25) return true

    return false
}

function isProbablyNoiseRegion(region, selectedLang, mode){
    
    if(mode === OCR_MODE.MANGA){
        return isProbablyMangaNoiseRegion(region,selectedLang)
    }

    return isProbablyDocumentNoiseRegion(region, selectedLang)
}

function getOCRLanguages(selectedLang){

    return [selectedLang]
}

function isCJKLanguage(language){
    return CJK_LANGUAGES.has(language)
}

function extractOCRWords(ocrData, selectedLang){
    if(!ocrData.tsv) return []

    const rows = ocrData.tsv.trim().split('\n').map(row => row.split('\t'))

    rows.shift()

    const words = []

    rows.forEach(columns => {

        if(columns.length < 12) return

        const [
            level,
            pageNum,
            blockNum,
            parNum,
            lineNum,
            wordNum,
            left,
            top,
            width,
            height,
            confidence
        ] = columns
    

        const text = columns.slice(11).join('\t').trim()

        if(Number(level) !== 5)return;

        if(!text) return

        const x = Number(left)
        const y = Number(top)
        const w = Number(width)
        const h = Number(height)
        const conf = Number(confidence)

        const word = {
            text,
            confidence: Number.isFinite(conf) ? conf : 0,
            pageNum: Number(pageNum),
            blockNum: Number(blockNum),
            parNum: Number(parNum),
            lineNum: Number(lineNum),
            wordNum: Number(wordNum),
            bbox: {
                x0: x,
                y0: y,
                x1: x + w,
                y1: y + h
            }  
        }

        if(isProbablyOCRNoise(word, selectedLang)){
            return
        }
        words.push(word)
    })
    return words
}

function createScaledOCRCanvas(imgElement, scale = 2){
    const width = imgElement.naturalWidth || imgElement.width
    const height = imgElement.naturalHeight || imgElement.height
    const canvas = document.createElement("canvas")
    canvas.width = Math.round(width * scale)
    canvas.height = Math.round(height * scale)

    const ctx = canvas.getContext("2d", {willReadFrequently: true})
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = "high"
    ctx.drawImage(
        imgElement,
        0,
        0,
        width,
        height,
        0,
        0,
        canvas.width,
        canvas.height
    )
    return canvas
}

function rescaleOCRResult(ocrData, scale){
    if(!ocrData?.tsv || scale === 1) return ocrData

    const rows = ocrData.tsv.split("\n")
    const scaledTSV = rows.map((row,index) => {
        if(index === 0 || !row.trim()) return row

        const columns = row.split("\t")

        if(columns.length < 10) return row

        for(const columnIndex of [6,7,8,9]){
            const value = Number(columns[columnIndex])
            if(Number.isFinite(value)){
                columns[columnIndex] = String(Math.round(value / scale))
            }
        }
        return columns.join("\t")
    }).join("\n")

    return {...ocrData, tsv: scaledTSV}
}

function inspectSparseMode(ocrData, selectedLang){

    const words = extractOCRWords(ocrData, selectedLang)

    if(!words.length) return true

    const confidences = words.map(word =>
        Number(word.confidence) || 0
    )

    const averageConfidence = averageBbox(confidences)

    const lowConfidenceCount = confidences.filter(confidence =>
        confidence < 40
    ).length

    const lowConfidenceRatio = lowConfidenceCount / Math.max(words.length, 1)

    if(words.length < 4) return true
    if(averageConfidence < 50) return true
    if(lowConfidenceRatio > 0.5) return true

    return false
}

function createUpScaledRegionCanvas(imgElement, rectangle, scale = 3){
    const canvas = document.createElement("canvas")

    canvas.width = rectangle.width * scale
    canvas.height = rectangle.height * scale

    const ctx = canvas.getContext(
        "2d",
        {
            willReadFrequently: true
        }
    )

    ctx.imageSmoothingEnabled = false
    ctx.imageSmoothingQuality = "high"
    ctx.drawImage(
        imgElement,
        rectangle.left,
        rectangle.top,
        rectangle.width,
        rectangle.height,
        0,
        0,
        canvas.width,
        canvas.height
    )
    return canvas
}

function applyGrayscaleAndContrast(canvas, contrast = 1.4){
    const ctx = canvas.getContext(
        "2d",
        {
            willReadFrequently: true
        }
    )
    const imageData = ctx.getImageData(
        0,
        0,
        canvas.width,
        canvas.height
    )
    const data = imageData.data

    for(let i = 0; i < data.length; i+= 4){
        const gray = (
            data[i] * 0.299 +
            data[i + 1] * 0.587 +
            data[i + 2] * 0.114
        )

        const adjusted = Math.max(0, Math.min(255,(gray - 128) * contrast + 128))

        data[i] = adjusted
        data[i + 1] = adjusted
        data[i + 2] = adjusted
    }
    ctx.putImageData(imageData, 0, 0)

    return canvas
}

function applyOtsuThreshold(canvas){
    const ctx = canvas.getContext(
        "2d",
        {
            willReadFrequently: true
        }
    )
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)

    const data = imageData.data
    const histogram = new Array(256).fill(0)

    for(let i = 0; i < data.length; i += 4){
        const gray = Math.round(
            data[i] * 0.299 +
            data[i + 1] * 0.587 +
            data[i + 2] * 0.114
        )

        histogram[gray]++
    }

    const totalPixels = canvas.width * canvas.height

    let totalIntensity = 0

    for(let i = 0; i < 256; i++) {
        totalIntensity += i * histogram[i]
    }

    let backgroundWeight = 0
    let backgroundSum = 0

    let bestVariance = -1
    let threshold = 128

    for(let i = 0; i < 256; i++){
        backgroundWeight += histogram[i]

        if(backgroundWeight === 0) continue

        const foregroundWeight = totalPixels - backgroundWeight

        if(foregroundWeight === 0) break

        backgroundSum += i * histogram[i]

        const backgroundMean = backgroundSum / backgroundWeight

        const foregroundMean = (totalIntensity - backgroundSum) / foregroundWeight

        const variance = backgroundWeight * foregroundWeight * Math.pow(backgroundMean - foregroundMean, 2)
    
        if(variance > bestVariance) {
            bestVariance = variance
            threshold = i
        }
    }

    let darkPixels = 0
    let lightPixels = 0

    for(let i = 0; i < data.length; i+= 4){
        const gray = 
            data[i] * 0.299 +
            data[i + 1] * 0.587 +
            data[i + 2] * 0.114

        if(gray < threshold){
            darkPixels++
        }else {
            lightPixels++
        }
    }

    const invert = darkPixels > lightPixels

    for(let i = 0; i < data.length; i += 4){
        const gray = 
            data[i] * 0.299 +
            data[i + 1] * 0.587 +
            data[i + 2] * 0.114

        let value = gray < threshold ? 0 : 255

        if(invert) value = 255 - value

        data[i] = value
        data[i + 1] = value
        data[i + 2] = value
    }

    ctx.putImageData(imageData, 0, 0)

    return canvas
}

function cloneCanvas(source) {
    const canvas = document.createElement("canvas")

    canvas.width = source.width
    canvas.height = source.height

    const ctx = canvas.getContext("2d")

    ctx.drawImage(source, 0, 0)

    return canvas
}

function needsAggressiveRefinement(candidates) {

    const refinementCandidates = candidates.filter(candidate =>
        (candidate.preprocessing === "raw" || candidate.preprocessing === "contrast")
        && candidate.text)

    if(!refinementCandidates.length) return true

    const ordered = [...refinementCandidates].sort((a, b) => 
        (Number(b.confidence) || 0) - (Number(a.confidence) || 0))
    
    const best = ordered[0]
    
    if((Number(best.confidence) || 0) < 75) return true

    const distinctTexts = new Set(refinementCandidates.map(candidate => 
        normalizeForComparison(candidate.text)).filter(Boolean))

    if(distinctTexts.size > 1 && (Number(best.confidence) || 0) < 88) return true

    return false

}

function median(values){
    if(!values.length) return 0

    const sorted = [...values].sort((a,b) => a - b)

    const middle = Math.floor(sorted.length / 2)

    if(sorted.length % 2 === 0){
        return (sorted[middle - 1] + sorted[middle]) / 2
    }

    return sorted[middle]
}

function countCJKCharacters(text){
    return [...text || ""].filter(char => 
        /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(char)
    ).length
}

function scoreRegionOCRCandidate(candidate, region, selectedLang, allCandidates){
    if(!candidate?.text) return -Infinity

    let score = Number(candidate.confidence) || 0
    const text = normalizeForComparison(candidate.text)
    const chars = [...text].filter(char => 
        /[\p{L}\p{N}]/u.test(char)
    )
    if(isCJKLanguage(selectedLang)){
        const cjkCount = countCJKCharacters(text)
        const cjkRatio = cjkCount / Math.max(chars.length, 1)

        score += cjkCount * 2
        score += cjkRatio * 20

        if(cjkCount === 0) score -=  30
    }

    if(chars.length === 1)score -= 12

    const width = bboxWidth(region.bbox)
    const height = bboxHeight(region.bbox)

    if(candidate.orientation === "vertical"){
        if(height > width * 1.35) score += 8
        
    }else{
        if(width > height * 1.35) score += 8
    }

    for(const other of allCandidates){
        if(other === candidate) continue

        const otherText = normalizeForComparison(other.text)

        if(text && text === otherText){
            score += other.orientation === candidate.orientation ? 8 : 3
        }
    }

    if(candidate.preprocessing === "raw") score += 1

    if(candidate.preprocessing === "otsu") score -= 1

    const preferredOrientation = getPreferredOrientation(selectedLang)

    if(candidate.orientation === preferredOrientation) score += 8

    return score
}

function finalizeOCRCandidates(candidates, selectedLang){
    for(const candidate of candidates){
        candidate.score = scoreInitialOCRResult(candidate.result, candidate.language || selectedLang)
    }
    candidates.sort((a, b) => b.score - a.score)

    debugOCR("OCR initial candidates: ",
        candidates.map(candidate => ({
            mode: candidate.name,
            language: candidate.language,
            score: candidate.score,
            stats: getOCRResultStats(candidate.result, candidate.language || selectedLang)
        }))
    )

    debugOCR("OCR initial winner:", candidates[0]?.name)
}

function selectBestRegionOCRCandidate(candidates, region, selectedLang){
    return candidates.map(candidate => ({
        ...candidate,
        score: scoreRegionOCRCandidate(candidate, region, selectedLang, candidates)
    })).sort((a, b) => b.score - a.score)[0]
}

function scoreInitialOCRResult(ocrData, selectedLang){
    const stats = getOCRResultStats(ocrData, selectedLang)

    if(!stats.wordCount) return -Infinity

    const meaningfulWords = stats.words.filter(word => {
        const text = word.text?.trim() || ""

        if(!text) return false

        if(isCJKLanguage(selectedLang)){
            return (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(text))
        }
        return /[\p{L}\p{N}]/u.test(text)
    })

    const meaningfulRatio = meaningfulWords.length / Math.max(stats.wordCount, 1)

    return (meaningfulWords.length * 8 + stats.averageConfidence * 0.35 
        + meaningfulRatio * 30 - stats.lowConfidenceRatio * 25)
}

function shouldRefineRegion(region, selectedLang, mode){
    if(mode === OCR_MODE.MANGA){
        return (isCJKLanguage(selectedLang) || region.confidence < 92 || region.lines?.length > 1)
    }

    return (region.confidence < 70)
}


async function getOCRWorker(selectedLang){
    const languages = getOCRLanguages(selectedLang)
    const workerKey = languages.join("+")

    if(OCR_WORKERS.has(workerKey)) return OCR_WORKERS.get(workerKey)

    const isCJK = isCJKLanguage(selectedLang)

    console.log("Creating OCR worker: ", 
        {
            languages,
            legacyCompatibleCore: isCJK
        }
    )

    const worker = await Tesseract.createWorker(languages,
         Tesseract.OEM.LSTM_ONLY,
         {
            legacyCore: isCJK
         }
        )

    OCR_WORKERS.set(workerKey, worker)

    return worker
}

async function terminateOCRWorker(){
    for(const worker of OCR_WORKERS.values()){
        await worker.terminate()
    }
    OCR_WORKERS.clear()
}

async function recognizeWorker(worker, imageTarget, psm) {

    await worker.setParameters({
        tessedit_pageseg_mode: psm,
        user_defined_dpi: "300"
    })

    const response = await worker.recognize(
        imageTarget,
        {},
        {
            blocks: true,
            tsv: true,
        }
    )

    return response.data;
}

async function getRefinementWorker(selectedLang, orientation){
    const language = getRefinementLanguage(selectedLang, orientation)

    const workerKey = `refine: ${orientation}: ${language}`

    if(OCR_WORKERS.has(workerKey)){
        return {worker: OCR_WORKERS.get(workerKey), language}
    }

    const cjk = isCJKLanguage(language)

    console.log("Creating refinement OCR worker: ", {language, orientation})

    const worker = await Tesseract.createWorker(
        [language], Tesseract.OEM.LSTM_ONLY, { legacyCore: cjk})

    OCR_WORKERS.set(workerKey, worker)

    return {worker, language}
}

async function recognizeRefinementCanvas(worker, canvas, language, selectedLang, psm){
    await worker.setParameters({
        tessedit_pageseg_mode: psm,
        user_defined_dpi: "300"
    })

    const response = await worker.recognize(
        canvas,
        {},
        {
            text: true,
            tsv: true
        }
    )

    const data = response.data

    const words = extractOCRWords(data, language)

    const confidence = words.length
        ? averageBbox(words.map(word => word.confidence))
        : Number(data.confidence) || 0
    
    const layoutText = data.text?.replace(/\r/g, "").trim() || ""

    const text = normalizeOCRText(layoutText, selectedLang)

    return{
        text,
        layoutText,
        confidence,
        words
    }
}

async function refineTextRegions(regions, imgElement, selectedLang, mode){  
    const refinedRegions = []

    for(const region of regions){
        if(isHardNoiseRegion(region, selectedLang)){
            refinedRegions.push(region) 
            continue
        }

        const shouldRefine = shouldRefineRegion(region, selectedLang, mode)

        if(!shouldRefine){
            refinedRegions.push(region)
            continue
        }

        try{
            const refined = await recognizeRegionSecondPass(imgElement,region,selectedLang, mode)
            const useRefined = shouldUseRefinedOCR(region,refined,selectedLang)
            debugOCR("OCR second pass: ",{
                orientation: region.orientation,
                first: {
                    text: region.text,
                    confidence: region.confidence
                },
                second: {
                    text: refined.text,
                    confidence: refined.confidence,
                    language: refined.language,
                    psm: refined.psm,
                    preprocessing: refined.preprocessing,
                    scale: refined.scale,
                    score: refined.score
                },
                selected: useRefined ? "second" : "first"
            })

            refinedRegions.push({
                ...region,
                firstPassText: region.text,
                firstPassConfidence: region.confidence,
                secondPassLayoutText: refined.layoutText,
                secondPassText: refined.text,
                secondPassConfidence: refined.confidence,
                refinementLanguage: refined.language,
                refinementPSM: refined.psm,
                refinementRectangle: refined.rectangle,
                refinementPreprocessing: refined.preprocessing,
                refinementScale: refined.scale,
                refinementScore: refined.score,
                refinementCandidates: refined.candidates,
                refined: useRefined,
                text: useRefined ? refined.text : region.text,
                confidence: useRefined ? refined.confidence : region.confidence,
                orientation: useRefined ? (refined.orientation || region.orientation) : region.orientation,
                ocrLanguage: useRefined ? (refined.language || region.ocrLanguage) : region.ocrLanguage
            })
        }catch(e) {
            debugOCRError("Second OCR pass failed: ", e)
            refinedRegions.push(region)
        }
    }
    return refinedRegions
}

async function recognizeRegionOrientation(imgElement, region, selectedLang, orientation){
    const {worker, language} = await getRefinementWorker(selectedLang, orientation)
    const rectangle = createRefinementRectangle(region, imgElement, orientation)
    const scale = calculateOCRScale(region, orientation)
    const rawCanvas = createUpScaledRegionCanvas(imgElement,rectangle, scale)
    const contrastCanvas = cloneCanvas(rawCanvas)

    applyGrayscaleAndContrast(contrastCanvas, 1.4)

    const psm = orientation === "vertical"
        ? Tesseract.PSM.SINGLE_BLOCK_VERT_TEXT
        : region.lines?.length === 1
            ? Tesseract.PSM.SINGLE_LINE
            : Tesseract.PSM.SINGLE_BLOCK
    const raw = await recognizeRefinementCanvas(worker, rawCanvas, language, selectedLang, psm)
    const contrast = await recognizeRefinementCanvas(worker, contrastCanvas, language, selectedLang, psm)

    const candidates = [
        {
            ...raw,
            preprocessing: "raw",
            orientation,
            language,
            psm,
            rectangle,
            scale
        },
        {...contrast,
            preprocessing: "contrast",
            orientation,
            language,
            psm,
            rectangle,
            scale
        }
    ]
    if(needsAggressiveRefinement(candidates)){
        const aggressiveScale = Math.min(6, Math.max(scale, scale * 1.25))
        const otsuCanvas = createUpScaledRegionCanvas(imgElement, rectangle, aggressiveScale)
        applyOtsuThreshold(otsuCanvas)

        const otsu = await recognizeRefinementCanvas(worker, otsuCanvas, language, selectedLang, psm)

        candidates.push({
            ...otsu,
            preprocessing: "otsu",
            orientation,
            language,
            psm,
            rectangle,
            scale: aggressiveScale
        })
    }
    return candidates
}

async function recognizeRegionSecondPass(imgElement, region, selectedLang, mode){
    let orientations

    if(mode === OCR_MODE.MANGA && isCJKLanguage(selectedLang)){
        orientations = ["horizontal", "vertical"]
    }else if(isCJKLanguage(selectedLang)){
        orientations = [getPreferredOrientation(selectedLang)]
    }else {
        orientations = [region.orientation]
    }

    const candidates = []

    candidates.push({
        text: region.text,
        layoutText: region.rawText,
        words: region.lines.flatMap(line => line.words || []),
        confidence: region.confidence,
        preprocessing: "first-pass",
        orientation: region.orientation,
        language: region.ocrLanguage || selectedLang,
        psm: null,
        rectangle: null,
        scale: 1
    })

    for(const orientation of orientations){
        const orientationCandidates = await recognizeRegionOrientation(
            imgElement, region, selectedLang, orientation 
        )

        candidates.push(...orientationCandidates)
    }
    const best = selectBestRegionOCRCandidate(candidates, region, selectedLang)
    const firstPass = candidates[0]
    const firstPassScore = scoreRegionOCRCandidate(firstPass, region, selectedLang, candidates)
    
    debugOCR("OCR orientation candidates: ",
        candidates.map(candidate => ({
            orientation: candidate.orientation,
            preprocessing: candidate.preprocessing,
            language: candidate.language,
            psm: candidate.psm,
            text: candidate.text,
            confidence: candidate.confidence,
            scale: candidate.scale,
            rectangle: candidate.rectangle,
            score: scoreRegionOCRCandidate(candidate, region, selectedLang, candidates)
        }))
    )
    debugOCR("OCR orientation winner: ", {
        previousOrientation: region.orientation,
        orientation: best.orientation,
        preprocessing: best.preprocessing,
        text: best.text,
        confidence: best.confidence,
        score: best.score,
        firstPassScore
    })
    return {
        text: best.text, 
        layoutText: best.layoutText,
        confidence: best.confidence,
        words: best.words,
        preprocessing: best.preprocessing,
        orientation: best.orientation,
        language: best.language,
        psm: best.psm,
        rectangle: best.rectangle,
        scale: best.scale,
        score: best.score,
        firstPassScore,
        candidates
    }
}

async function readDocumentImage(imageTarget, selectedLang){
    const worker = await getOCRWorker(selectedLang)
    const vertical = isExplicitVerticalLanguage(selectedLang)
    const primaryPSM = vertical ? Tesseract.PSM.SINGLE_BLOCK_VERT_TEXT : Tesseract.PSM.AUTO
    const primaryResult = await recognizeWorker(worker, imageTarget, primaryPSM)
    const candidates = [{
        name: vertical ? "DOCUMENT_VERTICAL" : "DOCUMENT_AUTO",
        language: selectedLang,
        result: primaryResult
    }]

    if(inspectSparseMode(primaryResult, selectedLang)){
        const sparseResult = await recognizeWorker(worker, imageTarget, Tesseract.PSM.SPARSE_TEXT)

        candidates.push({
            name: "DOCUMENT_SPARSE_FALLBACK",
            language: selectedLang,
            result: sparseResult
        })
    }
    finalizeOCRCandidates(candidates, selectedLang)

    return {
        requestedMode: OCR_MODE.DOCUMENT,
        mode: OCR_MODE.DOCUMENT,
        candidates
    }
}

async function readMangaImage(imageTarget, selectedLang){
    const baseLanguage = getBaseLanguage(selectedLang)
    const {worker: horizontalWorker, language: horizontalLanguage} = await getRefinementWorker(baseLanguage, "horizontal")
    const {worker: verticalWorker, language: verticalLanguage} = await getRefinementWorker(baseLanguage, "vertical")
    const candidates = []
    const horizontalResult = await recognizeWorker(horizontalWorker, imageTarget, Tesseract.PSM.SPARSE_TEXT)

    candidates.push({
        name: "MANGA_HORIZONTAL",
        language: horizontalLanguage,
        result: horizontalResult
    })

    const verticalResult = await recognizeWorker(verticalWorker, imageTarget, Tesseract.PSM.SPARSE_TEXT)

    candidates.push({
        name: "MANGA_VERTICAL",
        language: verticalLanguage,
        result: verticalResult
    })

    const rescueScale = 2
    const scaledImage = createScaledOCRCanvas(imageTarget, rescueScale)
    const horizontal2xRaw = await recognizeWorker(horizontalWorker, scaledImage, Tesseract.PSM.SPARSE_TEXT)
    const horizontal2x = rescaleOCRResult(horizontal2xRaw, rescueScale)

    candidates.push({
        name: "MANGA_HORIZONTAL_2X",
        language: horizontalLanguage,
        result: horizontal2x
    })

    const vertical2xRaw = await recognizeWorker(verticalWorker, scaledImage, Tesseract.PSM.SPARSE_TEXT)
    const vertical2x = rescaleOCRResult(vertical2xRaw, rescueScale)

    candidates.push({
        name: "MANGA_VERTICAL_2X",
        language: verticalLanguage,
        result: vertical2x
    })

    finalizeOCRCandidates(candidates, selectedLang)

    return {requestedMode: OCR_MODE.MANGA, mode: OCR_MODE.MANGA, candidates}
}

async function readAutoImage(imageTarget, selectedLang){
    const worker = await getOCRWorker(selectedLang)
    const vertical = isExplicitVerticalLanguage(selectedLang)
    const documentPSM = vertical ? Tesseract.PSM.SINGLE_BLOCK_VERT_TEXT : Tesseract.PSM.AUTO
    const documentResult = await recognizeWorker(worker, imageTarget, documentPSM)
    const unreliable = inspectSparseMode(documentResult, selectedLang)

    if(!unreliable){
        const candidates = [{
            name: "AUTO_DOCUMENT",
            language: selectedLang,
            result: documentResult
        }]

        finalizeOCRCandidates(candidates,selectedLang)

        debugOCR("OCR auto resolved mode: ", OCR_MODE.DOCUMENT)

        return {requestedMode: OCR_MODE.AUTO, mode: OCR_MODE.DOCUMENT, candidates}
    }

    debugOCR("OCR auto resolved mode: ", OCR_MODE.MANGA)

    const mangaResult = await readMangaImage(imageTarget, selectedLang)

    return {...mangaResult, requestedMode: OCR_MODE.AUTO, mode: OCR_MODE.MANGA}
}

async function readImage(imageTarget, selectedLang, mode = OCR_MODE.AUTO){
    const normalizedMode = normalizeOCRMode(mode)

    debugOCR("OCR configuration:", { 
        requestedMode: normalizedMode,
        language: selectedLang,
        preferredOrientation: getPreferredOrientation(selectedLang)
    })

    switch(normalizedMode){
        case OCR_MODE.MANGA:
            return await readMangaImage(imageTarget, selectedLang)

        case OCR_MODE.DOCUMENT:
            return await readDocumentImage(imageTarget, selectedLang)
        case OCR_MODE.AUTO:
            default:
                return await readAutoImage(imageTarget, selectedLang)
    }
}

function getOCRResultStats(ocrData, selectedLang){
    const words = extractOCRWords(ocrData, selectedLang)
    const confidences = words.map(word =>
        Number(word.confidence) || 0
    )
    const averageConfidence = confidences.length ? averageBbox(confidences) : 0
    const lowConfidenceWords = words.filter(word => 
        (Number(word.confidence) || 0) < 40)

    const lowConfidenceRatio = lowConfidenceWords.length / Math.max(words.length, 1)

    return {
        words, 
        wordCount: words.length,
        averageConfidence,
        lowConfidenceRatio,
        blockCount: ocrData.blocks?.length || 0
    }
}

function normalizeForComparison(text){
    return (text || "").replace(/\s+/g, "").trim()
}

function calculateOCRScale(region, orientation = region.orientation){
    if(!region.lines?.length) return 3

    const sizes = region.lines.map(line => {
        if(orientation === "vertical"){
            return bboxWidth(line.bbox)
        }
        return bboxHeight(line.bbox)
    }).filter(size => Number.isFinite(size) && size > 0)

    const averageSize = averageBbox(sizes)
    const targetSize = 60
    const scale = targetSize / Math.max(averageSize, 1)

    return Math.max(2, Math.min(5, scale))
}



//calculo primitivo usando o posicionamento do x e y 
//largura e tamanho usados para ver se o texto esta na vertical ou horizontal
function bboxWidth(bbox){
    return bbox.x1 - bbox.x0
}
function bboxHeight(bbox){
    return bbox.y1 - bbox.y0
}
function bboxCenterX(bbox){
    return (bbox.x0 + bbox.x1) / 2
}
function bboxCenterY(bbox){
    return (bbox.y0 + bbox.y1) / 2
}
function mergeBboxes(a, b){
    return{ 
        x0: Math.min(a.x0, b.x0),
        y0: Math.min(a.y0, b.y0),
        x1: Math.max(a.x1, b.x1),
        y1: Math.max(a.y1, b.y1)
    }
    
}
function calculateBoundingBox(items){
    if(!items.length) return null

    let bbox = {...items[0].bbox}

    for(let i = 1; i < items.length; i++){
        bbox = mergeBboxes(bbox, items[i].bbox)
    }
    return bbox
}
function averageBbox(values){
    if(!values.length) return 0;

    return (values.reduce((sum, value) => sum + value, 0) / values.length)
}

function detectLineOrientation(words,bbox,selectedLang){
    if(selectedLang.endsWith("_vert")) return "vertical"

    if(isCJKLanguage(selectedLang)){
        if(words.length >= 2){
            const centersX = words.map(word => bboxCenterX(word.bbox))
            const centersY = words.map(word => bboxCenterY(word.bbox))
            const spreadX = Math.max(...centersX) - Math.min(...centersX)
            const spreadY = Math.max(...centersY) - Math.min(...centersY)
        
             if(spreadY > spreadX * 1.3) return "vertical"
        }


        if(bboxHeight(bbox) > bboxWidth(bbox) * 1.8){
            return "vertical"
        }
    }
    return "horizontal"
}

function splitHorizontalWordsByGap(words) {
    if(words.length <= 1) return [words]

    const ordered = [...words].sort((a,b) => a.bbox.x0 - b.bbox.x0)
    const heights = ordered.map(word => bboxHeight(word.bbox))
    const averageHeight = averageBbox(heights)
    const maxGap = Math.max(averageHeight * 2.2, 18)
    const groups = []

    let currentGroup = [ordered[0]]

    for(let i = 1; i < ordered.length; i++){
        const previous = ordered[i - 1]
        const current = ordered[i]
        const gap = current.bbox.x0 - previous.bbox.x1
        if(gap > maxGap) {
            groups.push(currentGroup)
            currentGroup = [current]
        }else{
            currentGroup.push(current)
        }
    }

    if(currentGroup.length){
        groups.push(currentGroup)
    }

    return groups
}

function ocrBboxArea(bbox){
    return (Math.max(0, bbox.x1 - bbox.x0) * Math.max(0, bbox.y1 - bbox.y0))
    
}

function ocrBboxIntersectionArea(a, b){
    const x0 = Math.max(a.x0, b.x0)
    const y0 = Math.max(a.y0, b.y0)
    const x1 = Math.min(a.x1, b.x1)
    const y1 = Math.min(a.y1, b.y1)

    if(x1 <= x0 || y1 <= y0) return 0

    return ((x1 - x0) * (y1 - y0))
}

function ocrRegionOverlap(a,b){
    const intersection = ocrBboxIntersectionArea(a.bbox,b.bbox)
    if(!intersection) return 0

    const smallerArea = Math.min(ocrBboxArea(a.bbox), ocrBboxArea(b.bbox))
    if(!smallerArea) return 0

    return(intersection / smallerArea)
}

function scoreOCRRegion(region, selectedLang){
    const text = region.text?.trim() || ""
    const chars = [...text].filter(char => !/\s/u.test(char))

    const meaningful = chars.filter(char => /[\p{L}\p{N}]/u.test(char))

    let cjkCount = 0

    if(isCJKLanguage(selectedLang)){
        cjkCount = meaningful.filter(char => 
            /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(char)
        ).length
    }

    const confidence = Number(region.confidence) || 0

    const preferredOrientation = getPreferredOrientation(selectedLang)

    const orientationBonus = region.orientation === preferredOrientation ? 10 : 0

    return (cjkCount * 12 + meaningful.length * 3 + confidence + orientationBonus)
}

function mergeOCRCandidateRegions(ocrData, selectedLang){
    const candidateData = Array.isArray(ocrData?.candidates)
        ? ocrData.candidates
        : [{name: "LEGACY", language: selectedLang, result: ocrData}]

    const allRegions = []

    for(const candidate of candidateData){
        if(!candidate?.result) continue

        const candidateLanguage = candidate.language || selectedLang
        const structure = buildOCRStructure(candidate.result, candidateLanguage)

        debugOCR(`OCR regions from ${candidate.name}:`,
            structure.regions.map(region => ({
                text: region.text,
                confidence: region.confidence,
                orientation: region.orientation,
                bbox: region.bbox
            }))
        )

        for(const region of structure.regions){
            allRegions.push({
                ...region,
                ocrSource: candidate.name,
                ocrLanguage: candidateLanguage
            })
        }
    }
    allRegions.sort((a,b) =>
        scoreOCRRegion(b, selectedLang) - scoreOCRRegion(a, selectedLang)
    )

    const merged = []

    for(const region of allRegions){
        const duplicateIndex = merged.findIndex(existing =>
            ocrRegionOverlap(existing, region) >= 0.6
        )

        if(duplicateIndex === -1){
            merged.push({
                ...region,
                ocrSupportSources: [region.ocrSource],
                ocrSupportCount: 1
            })
            continue
        }
        const existing = merged[duplicateIndex]
        const supportSources = new Set([
            ...(existing.ocrSupportSources || []),
            region.ocrSource
        ])

        const existingScore = scoreOCRRegion(existing, selectedLang)
        const incomingScore = scoreOCRRegion(region, selectedLang)

        if(incomingScore > existingScore){
            merged[duplicateIndex] = {
                ...region,
                ocrSupportSources: [...supportSources],
                ocrSupportCount: supportSources.size
            }
        }else{
            existing.ocrSupportSources = [...supportSources]
            existing.ocrSupportCount = supportSources.size
        }
    }

    return merged.map((region, index) => ({
        ...region,
        id: `region-${index}`
    }))
}

function buildOCRLines(words, selectedLang){
    const lineMap = new Map()

    words.forEach(word => {
        const key = [
            word.pageNum,
            word.blockNum,
            word.parNum,
            word.lineNum
        ].join("-")

        if(!lineMap.has(key)){
            lineMap.set(key, [])
        }

        lineMap.get(key).push(word)
    })
    const lines = []

    lineMap.forEach((tesseractWords, key) => {
        const originalBbox = calculateBoundingBox(tesseractWords)
        const orientation = detectLineOrientation(tesseractWords, originalBbox, selectedLang)

        const wordGroups = orientation === "horizontal" 
            ? splitHorizontalWordsByGap(tesseractWords) : [tesseractWords]

        wordGroups.forEach((lineWords, groupIndex) => {
            const bbox = calculateBoundingBox(lineWords)
            const finalOrientation = detectLineOrientation(lineWords, bbox, selectedLang)
            
            lineWords.sort((a, b) => {
                if(finalOrientation === "vertical") return (a.bbox.y0 - b.bbox.y0)


                return (a.bbox.x0 - b.bbox.x0)
            })

            const separator = usesNoWordSpaces(selectedLang) ? "" : " "

            const text = lineWords.map(word => word.text).join(separator)
            const confidence = averageBbox(lineWords.map(word => word.confidence))

            lines.push({
                id: `${key}-${groupIndex}`,
                text,
                words: lineWords,
                confidence,
                orientation: finalOrientation,
                bbox,
                pageNum: lineWords[0].pageNum,
                blockNum: lineWords[0].blockNum,
                parNum: lineWords[0].parNum,
                lineNum: lineWords[0].lineNum
            })
        })

    })
    return lines
}


function axisGap(aStart,aEnd,bStart,bEnd){
    if(aEnd < bStart) return bStart - aEnd

    if(bEnd < aStart) return aStart - bEnd


    return 0
}

function overlapRatio(aStart, aEnd, bStart, bEnd){
    const overlap = Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart))
    const smallest = Math.min(aEnd - aStart, bEnd - bStart)

    if(smallest <= 0) return 0

    return overlap / smallest
}

//com base na distancia das linhas, juntar elas em diferentes regiões
//para formar clusters diferentes de divs exatamente sobre o texto original

function canMergeLineIntoRegion(region,line, selectedLang){
    if(region.orientation !== line.orientation) return false

    const regionBox = region.bbox
    const lineBox = line.bbox

    const lineThickness = line.orientation === "vertical"
        ? bboxWidth(lineBox)
        : bboxHeight(lineBox)

    const regionThickness = averageBbox(region.lines.map(regionLine =>
        regionLine.orientation === "vertical"
            ? bboxWidth(regionLine.bbox) : bboxHeight(regionLine.bbox)
    ))

    const sizeRatio = Math.max(lineThickness, regionThickness) /
        Math.max(1, Math.min(lineThickness, regionThickness))
    
    if(sizeRatio > 2.5) return false


    if(line.orientation === "horizontal"){
        const verticalGap = axisGap(regionBox.y0, regionBox.y1, lineBox.y0, lineBox.y1)
        const horizontalOverlap = overlapRatio(regionBox.x0, regionBox.x1, lineBox.x0, lineBox.x1)
        const verticalOverlap = overlapRatio(regionBox.y0, regionBox.y1, lineBox.y0, lineBox.y1)
        const centerDifference = Math.abs(bboxCenterX(regionBox) - bboxCenterX(lineBox))
        const maxWidth = Math.max(bboxWidth(regionBox),bboxWidth(lineBox))
        const maxGap = Math.max(regionThickness, lineThickness) * 1.7

        const sameRow = verticalOverlap > 0.60
        const separatedHorizontally = horizontalOverlap < 0.10

        if(sameRow && separatedHorizontally) return false

        return (verticalGap <= maxGap && 
            (horizontalOverlap > 0.20 || centerDifference < maxWidth * 0.25))
    }

    const neighborMetrics = region.lines.map(existingLine => {
        const existingBox = existingLine.bbox

        return {
            horizontalGap: axisGap(existingBox.x0, existingBox.x1, lineBox.x0, lineBox.x1),
            verticalOverlap: overlapRatio(existingBox.y0, existingBox.y1, lineBox.y0, lineBox.y1),
            thickness: bboxWidth(existingBox)
        }
    })

    const compatibleNeighbors = neighborMetrics.filter(neighbor => neighbor.verticalOverlap > 0.35)

    if(!compatibleNeighbors.length) return false

    compatibleNeighbors.sort((a, b) => a.horizontalGap - b.horizontalGap)

    const nearest = compatibleNeighbors[0]
    const maxGap = Math.max(lineThickness, nearest.thickness) * (usesNoWordSpaces(selectedLang) ? 1.8 : 1.5)

    return (nearest.horizontalGap <= maxGap)
}

function regionDistance(region,line){
    if(line.orientation === "horizontal"){
        const yGap = axisGap(region.bbox.y0, region.bbox.y1, line.bbox.y0, line.bbox.y1)
        const xDistance = Math.abs(bboxCenterX(region.bbox) - bboxCenterX(line.bbox))

        return (yGap + xDistance * 0.15)
    }

    const xGap = axisGap(region.bbox.x0, region.bbox.x1, line.bbox.x0, line.bbox.x1)
    const yDistance = Math.abs(bboxCenterY(region.bbox) - bboxCenterY(line.bbox))

    return (xGap + yDistance * 0.15)
}

function buildTextRegions(lines, selectedLang){
    const regions = []

    const orderedLines = [...lines].sort((a,b) => a.bbox.y0 - b.bbox.y0)

    orderedLines.forEach(line => {
        const candidates = regions
            .filter(region => canMergeLineIntoRegion(region,line, selectedLang))
            .sort((a,b) => regionDistance(a, line) - regionDistance(b, line))

        const region = candidates[0]

        if(!region){
            regions.push({
                orientation: line.orientation,
                lines: [line],
                bbox: {...line.bbox}
            })
            return
        }

        region.lines.push(line)

        region.bbox = mergeBboxes(region.bbox, line.bbox)
    })

    return regions.map((region, index) => {
        let regionLines = [...region.lines]

        if(region.orientation === "vertical"){
            regionLines.sort((a, b) => b.bbox.x0 - a.bbox.x0)
        }else{
            regionLines.sort((a, b) => a.bbox.y0 - b.bbox.y0)
        }

        const rawText = regionLines.map(line => line.text).join('\n')

        let text

        if(usesNoWordSpaces(selectedLang)){
            text = regionLines.map(line => line.text).join('')
        }else{
            text = regionLines.map(line => line.text).join(' ')
        }

        return {
            id: `region-${index}`,
            text,
            rawText,
            orientation: region.orientation,
            bbox: region.bbox,
            lines: regionLines,
            confidence: averageBbox(regionLines.map(line => line.confidence))
        }
    })
}

function buildOCRStructure(ocrData, selectedLang){
    const words = extractOCRWords(ocrData, selectedLang)
    const lines = buildOCRLines(words, selectedLang)
    const regions = buildTextRegions(lines, selectedLang)

    return { words, lines, regions}
}

function loadImageFromSource(src){
    return new Promise((resolve, reject) => {
        const image = new Image()

        image.onload = () => resolve(image)
        image.onerror = () => reject(new Error("Failed to load OCR image"))

        image.src = src
    })
}

async function getOCRSafeImage(pageImage){
    const src = pageImage.currentSrc || pageImage.src

    if(!src) throw new Error("Image has no source")

    if(src.startsWith("data:")) return await loadImageFromSource(src)

    try{
        const url = new URL(src, location.href)

        if(url.origin === location.origin) return pageImage
    }catch(e){
        console.warn("Could not inspect image URL: ", e)
    }

    const response = await chrome.runtime.sendMessage({
        type: "FETCH_IMAGE_FOR_OCR",
        url: src
    })

    if(!response?.ok) throw new Error(response?.error || "Could not fetch OCR image")

    return await loadImageFromSource(response.dataUrl)
}


//comunicação com o ollama

function getLowConfidenceOCRWords(region, threshold = 40){
    return region.lines?.flatMap(line => line.words || [])
        .filter(word => (Number(word.confidence) || 0) < threshold)
        .map(word => ({
            text: word.text,
            confidence: Number(word.confidence) || 0
        })) || []
}

export async function translateOCRRegion(region, sourceLanguage, targetLanguage){
    if(!region?.text) return null

    const lowConfidenceWords = getLowConfidenceOCRWords(region)

    const response = await chrome.runtime.sendMessage({
        type: "OLLAMA_TRANSLATE",
        payload: {
            text: region.text,
            sourceLanguage: getBaseLanguage(sourceLanguage),
            targetLanguage,
            lowConfidenceWords
        }
    })
    if(!response) throw new Error("Background returned no response")
    if(!response.ok) throw new Error(response.error || "Ollama translation failed")

    return response.result
    } 

async function drawTranslationBlocks(ocrData, ocrImage, displayImage, sourceLanguage, targetLanguage){

    const resolvedMode = ocrData.mode || OCR_MODE.AUTO

    const firstPassRegions = mergeOCRCandidateRegions(ocrData, sourceLanguage)

    debugOCR("OCR merged first-pass regions:",
        firstPassRegions.map(region => ({
            source: region.ocrSource,
            language: region.ocrLanguage,
            text: region.text,
            confidence: region.confidence,
            orientation: region.orientation,
            bbox: region.bbox,
            supportCount: region.ocrSupportCount,
            supportSources: region.ocrSupportSources
        }))
    )

    const regions = await refineTextRegions(firstPassRegions, ocrImage, sourceLanguage, resolvedMode)

    if(regions.length === 0) {
        console.warn("No region found") 
        return
    }

    const naturalWidth = ocrImage.naturalWidth
    const naturalHeight = ocrImage.naturalHeight

    if(!naturalWidth || !naturalHeight) {
        console.warn("No natural image dimentions") 
        return
    }

    const overlay = createImageOverlay(displayImage)

    const translationJobs = []

    for(const [index, region] of regions.entries()){

        if(isProbablyNoiseRegion(region, sourceLanguage, resolvedMode)){
            debugOCR("OCR region removed as noise:", region)
            continue;
        }

        const originalText = region.text.trim();

        if(!originalText) continue;

        if(!isCJKLanguage(sourceLanguage) && originalText.length < 2) continue;

        const bbox = region.bbox
        const leftBox = (bbox.x0 / naturalWidth) * 100
        const topBox = (bbox.y0 / naturalHeight) * 100
        const widthBox = ((bbox.x1 - bbox.x0) / naturalWidth) * 100
        const heightBox = ((bbox.y1 - bbox.y0) / naturalHeight) * 100

        debugOCR(`Region ${index}: `, 
            {   text: originalText, 
                orientation: region.orientation, 
                confidence: region.confidence,
                bbox
            }
        )

        const balon = document.createElement('div')

        balon.className = "ocr-translation-region"

        //Info para o ollama
        balon.dataset.originalText = originalText
        balon.dataset.orientation = region.orientation
        balon.dataset.regionId = region.id

        balon.style.cssText = `
            position: absolute !important;
            z-index: 200 !important;
            left: ${leftBox}% !important;
            top: ${topBox}% !important;
            width: ${widthBox}% !important;
            height: ${heightBox}% !important;
            background-color: white !important;
            color: black !important;
            border-radius: 6px !important;
            padding: 4px !important;
            margin: 0 !important;
            box-sizing: border-box !important;
            font-family: sans-serif !important;
            font-size: 12px !important;
            overflow: hidden !important;
            line-height: 1.05 !important;
            display: flex !important;
            align-items: center !important;
            justify-content: center !important;
            text-align: center !important;
            white-space: normal !important;
            pointer-events: none !important; 
        `

        balon.style.writingMode = "horizontal-tb"
        balon.style.textOrientation = "mixed"
        balon.innerText = "Translating..."

        overlay.appendChild(balon)

        const job = translateOCRRegion(region, sourceLanguage, targetLanguage).then(
            translationResult => {
                if(!translationResult?.translation) throw new Error("Empty translation")

                balon.innerText = translationResult.translation
                balon.dataset.correctedText = translationResult.correctedText || originalText
                
                debugOCR(`Translation ${index}:`,{
                    original: originalText,
                    corrected: translationResult.correctedText,
                    translation:
                    translationResult.translation,
                    corrections: translationResult.corrections
                })
                return translationResult
            }
        ).catch(e => {
            debugOCRError(`Translation failed for region ${index}:`, e)
            balon.innerText = originalText
            balon.dataset.translationError = "true"

            throw e
        })
        translationJobs.push(job)
    }
    await Promise.allSettled(translationJobs)
}

//botao temporario para traducao
function setupImageHover() {
    const images = document.querySelectorAll('img')
    
    const translationBtn = document.createElement('button')
    translationBtn.innerText = 'Translate'
    translationBtn.style.cssText = `
        position: absolute;
        z-index: 999;
        background: #2196f3;
        color: white;
        border: none;
        padding: 8px 12px;
        border-radius: 4px;
        display: none;
        font-family: sans-serif;
        font-size: 14px;
        box-shadow: 0 2px 4px rgba(0,0,0,0.3);
    `
    document.body.appendChild(translationBtn)

    let currentImage = null
    let ocrRunId = 0


    images.forEach(img => {
        if(img.width < 150 || img.height < 150) return;

        img.addEventListener('mouseenter', () => {
            chrome.storage.local.get(['translationActive'], (data) => {
                if(data.translationActive) {
                    currentImage = img
                    const rect = img.getBoundingClientRect()

                    translationBtn.style.display = 'block'
                    translationBtn.style.top = `${rect.top + window.scrollY + 10}px`
                    translationBtn.style.left = `${rect.left + window.scrollX + 10}px`
                }
            })
        })

        img.addEventListener('mouseleave', (e) => {
            if(e.relatedTarget !== translationBtn){
                translationBtn.style.display = 'none'
            }
        })
    })

        translationBtn.addEventListener('mouseleave', () => {
            translationBtn.style.display = 'none'

        })

        translationBtn.addEventListener('click', async (e) => {
            e.preventDefault()
            e.stopPropagation()

            if(!currentImage) return

            translationBtn.innerText = 'Reading...'

            chrome.storage.local.get(['langFrom', 'langTo', 'ocrMode'], async (data) => {
                
                const sourceLanguage = data.langFrom
                const targetLanguage = data.langTo
                const ocrMode = normalizeOCRMode(data.ocrMode)

                if(!sourceLanguage || !targetLanguage){
                    debugOCRError("Nenhum idioma de origem configurado")
                    translationBtn.innerText = "No language"
                    return
                }

                const runId = ++ocrRunId

                OCR_DEBUG.events.length = 0


                debugOCR("OCR run started:", {
                    runId,
                    sourceLanguage,
                    targetLanguage,
                    ocrMode,
                    preferredOrientation: getPreferredOrientation(sourceLanguage),
                    image: {
                        src: currentImage?.currentSrc || currentImage?.src,
                        width: currentImage?.naturalWidth,
                        height: currentImage?.naturalHeight,
                    }
                })

                const targetImage = currentImage

                if(!targetImage) return

                try{
                    translationBtn.innerText = "Reading..."
                    const ocrImage = await getOCRSafeImage(targetImage)
                    const ocrData = await readImage(ocrImage, sourceLanguage, ocrMode)

                    if(runId !== ocrRunId) return

                    translationBtn.innerText = "Translating..."

                    await drawTranslationBlocks(ocrData, ocrImage, targetImage, sourceLanguage, targetLanguage)

                    if(runId !== ocrRunId){
                        removeImageOverlay(targetImage)
                        return
                    }

                    translationBtn.innerText = 'Done'
                }catch(e){
                    if(runId !== ocrRunId) return
                    debugOCRError('Erro no Tesseract: ', e)
                    translationBtn.innerText = 'Erro'
                }
                setTimeout(() => {
                    if(runId !== ocrRunId) return
                    translationBtn.style.display = 'none';
                    translationBtn.innerText = 'Traduzir';
                }, 2000)
            })
        })

        chrome.storage.onChanged.addListener( async (changes, areaName) => {
            if(areaName !== "local") return
            if(!changes.translationActive) return

            const active = changes.translationActive.newValue

                if(!active) {
                    ocrRunId++
                    removeAllTranslationOverlays()

                    await terminateOCRWorker()

                    translationBtn.style.display = "none"

                    currentImage = null
                }
            
        })
}

setupImageHover()