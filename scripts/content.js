import Tesseract from "tesseract.js";

//overlay que acompanha a imagem apos redimencionamento


const imageOverlay = new Map()

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

function meaningfulCharacterCount(text) {
    return [...text.replace(/\s/g, "")].length
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

function shouldPreferSparseResult(autoResult, sparseResult, selectedLang){
    const auto = getOCRResultStats(autoResult, selectedLang)
    const sparse = getOCRResultStats(sparseResult, selectedLang)

    if(!sparse.wordCount) return false
    if(!auto.wordCount) return true

    const muchBetterConfidence = sparse.averageConfidence >= auto.averageConfidence + 7
    const muchMoreText = sparse.wordCount >= auto.wordCount * 1.4 
        && sparse.averageConfidence >= auto.averageConfidence - 3

    const worseNoise = sparse.lowConfidenceRatio > auto.lowConfidenceRatio + 0.15

    if(worseNoise) return false

    return (muchBetterConfidence || muchMoreText)
}

function shouldUseRefinedOCR(region,refined,selectedLang){
    if(!refined.text) return false

    const firstLength = meaningfulCharacterCount(region.text)
    const refinedLength = meaningfulCharacterCount(refined.text)

    if(firstLength > 0 && refinedLength < firstLength * 0.65) return false

    if(normalizeForComparison(refined.text) === normalizeForComparison(region.text)) return true

    let allStrong

    if(refined.preprocessing === "first-pass+micro"){
        const corrections = refined.microCorrections || []
        allStrong = corrections.length > 0 && corrections.every(correction =>
            correction.consensus === true && correction.microConfidence >= 70
        )
    }

    if(allStrong) return true

    if(refined.confidence < 25) return false

    if(isCJKLanguage(selectedLang)){
        return (refined.confidence >= region.confidence - 8) 
    }

    return( refined.confidence >= region.confidence - 5)
}

function createRefinementRectangle(region, imgElement){

    const bbox = region.bbox
    const orientation = region.orientation

    const thicknesses = region.lines?.map(line => {
        if(orientation === "vertical"){
            return bboxWidth(line.bbox)
        }
        return bboxHeight(line.bbox)
    }) || []

    const averageThickness = thicknesses.length ? averageBbox(thicknesses)
        : (orientation === "vertical" ? bboxWidth(bbox) : bboxHeight(bbox))

    const padding = Math.min(20, Math.max(4, Math.round(averageThickness * 0.35)))
    const left = Math.max(0, Math.floor(bbox.x0 - padding))
    const top = Math.max(0, Math.floor(bbox.y0 - padding))
    const right = Math.min(imgElement.naturalWidth, Math.ceil(bbox.x1 + padding))
    const bottom = Math.min(imgElement.naturalHeight, Math.ceil(bbox.y1 + padding))

    return {
        left,
        top,
        width: Math.max(1, right - left),
        height: Math.max(1, bottom - top)
    }
}

function isProbablyNoiseRegion(region, selectedLang){
    if(isCJKLanguage(selectedLang)) return false

    const text = region.text.trim()

    if(!text) return true

    if(text.length <= 4 && region.confidence < 35) return true

    const hasLetterOrNumber = /[\p{L}\p{N}]/u.test(text)

    if(!hasLetterOrNumber && region.confidence < 85) return true

    return false
}

function getOCRLanguages(selectedLang){
    if(selectedLang.endsWith("_vert")){
        return [selectedLang]
    }

    const verticalLang = VERTICAL_LANGUAGE_MAP[selectedLang]

    if(verticalLang) {
        return [selectedLang, verticalLang]
    }
    return [selectedLang]
}

function isCJKLanguage(language){
    return CJK_LANGUAGES.has(language)
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

function getRefinementPSM(region) {
    if(region.orientation == "vertical"){
        return Tesseract.PSM.SINGLE_BLOCK_VERT_TEXT
    }
    if(region.lines?.length === 1){
        return Tesseract.PSM.SINGLE_LINE
    }

    return Tesseract.PSM.SINGLE_BLOCK
}

function getReliableLineWords(context){
    const words = context.lineWords?.length
        ? context.lineWords
        : context.words
    const targetKey = getOCRWordKey(context.target)
    const withoutTarget = words.filter(word => getOCRWordKey(word) !== targetKey)

    return withoutTarget.length ? withoutTarget : words
}

function getLowConfidenceWords(region,threshold = 30, maxWords = 3){
    const suspicious = []

    const regionConfidence = Number(region.confidence) || 0

    for(const line of region.lines || []){
        for(const word of line.words || []){
            const confidence = Number(word.confidence) || 0
            const relativeDrop = regionConfidence - confidence
            const absolutelyLow = confidence < threshold
            const unusuallyLow = regionConfidence >= 75 && relativeDrop >= 35

            if(absolutelyLow || unusuallyLow){
                suspicious.push({
                    word,
                    line,
                    severity: Math.max(threshold - confidence, relativeDrop)
                })
            }
        }
    }
    return suspicious.sort((a,b) => b.severity - a.severity).slice(0, maxWords)
}

function getOCRWordKey(word){
    return [
        word.pageNum,
        word.blockNum,
        word.parNum,
        word.lineNum,
        word.wordNum
    ].join("-")
}

function getWordContext(line,targetWord,radius = 1){
    const words = line.words || []

    const targetKey = getOCRWordKey(targetWord)

    const index = words.findIndex(word => getOCRWordKey(word) === targetKey)

    if(index === -1) return null

    const start = Math.max(0, index - radius)
    const end = Math.min(words.length, index + radius + 1)

    return {
        words: words.slice(start, end),
        lineWords: words,
        before: words.slice(start, index),
        target: targetWord,
        after: words.slice(index + 1, end),
        lineBBox: line.bbox
    }
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

function createMicroRefinementRectangle(context, imgElement, orientation){
    const bbox = calculateBoundingBox(context.words)

    if(!bbox) return null

    const reliableWords = getReliableLineWords(context)

    const sizes = reliableWords.map(word => orientation === "vertical"
        ? bboxWidth(word.bbox)
        : bboxHeight(word.bbox)
    ).filter(size => Number.isFinite(size) && size > 0)

    const typicalSize = median(sizes) || estimateLineThickness(context, orientation) || 12
    const padding = Math.max(4, Math.round(typicalSize * 0.45))
    const left = Math.max(0, Math.floor(bbox.x0 - padding))
    const top = Math.max(0, Math.floor(bbox.y0 - padding))
    const right = Math.min(imgElement.naturalWidth, Math.ceil(bbox.x1 + padding))
    const bottom = Math.min(imgElement.naturalHeight, Math.ceil(bbox.y1 + padding))

    return {
        left,
        top,
        width: Math.max(1, right - left),
        height: Math.max(1, bottom - top)
    }
}

function calculateMicroAdjustedConfidence(region, corrections){
    if(!corrections.length) return region.confidence

    const corrected = new Map(corrections.map(
        correction => [correction.wordKey, correction.microConfidence]
    ))
    const confidences = region.lines.flatMap(line => line.words || []).map(
        word => { 
            const key = getOCRWordKey(word)

            return corrected.has(key) 
                ? Number(corrected.get(key)) || 0 : Number(word.confidence) || 0
        }
    )

    return confidences.length ? averageBbox(confidences) : region.confidence
}

function calculateMicroOCRScale(context,orientation){

    const reliableWords = getReliableLineWords(context)

    const sizes = reliableWords.map(word => orientation === "vertical" 
        ? bboxWidth(word.bbox)
        : bboxHeight(word.bbox)
    ).filter(size => Number.isFinite(size) && size > 0)

    const typicalSize = median(sizes) || 12
    const targetSize = 90
    const scale = targetSize / Math.max(typicalSize, 1)

    return Math.max(4, Math.min(8, scale))
}

function extractMicroReplacement(text, context, selectedLang){
    if(!text) return null
    
    const normalize = value => {
        const normalized = normalizeOCRText(value || "", selectedLang)
        
        return usesNoWordSpaces(selectedLang)
            ? normalized.replace(/\s+/g, "")
            : normalized.replace(/\s+/g, " ").trim()
    }

    const result = normalize(text)
    const separator = usesNoWordSpaces(selectedLang) ? "" : " "
    const before = normalize(context.before.map(word => word.text).join(separator))
    const after = normalize(context.after.map(word => word.text).join(separator))

    if(before && !result.startsWith(before)) return null

    if(after && !result.endsWith(after)) return null

    let replacement = result

    if(before){
        replacement = replacement.slice(before.length)
    }
    if(after){
        replacement = replacement.slice(0, replacement.length - after.length)
    }

    replacement = replacement.trim()

    if(!replacement) return null

    const originalLength = [...context.target.text].length
    const replacementLength = [...replacement].length

    if(originalLength === 1 && replacementLength !== 1) return null

    if(originalLength > 1 && Math.abs(replacementLength - originalLength) > 1) return null

    return replacement
}

function estimateLineThickness(context, orientation){
    const words = getReliableLineWords(context)

    const sizes = words.map(word => orientation === "vertical"
        ? bboxWidth(word.bbox) : bboxHeight(word.bbox)
    ).filter(size => Number.isFinite(size) && size > 0)

    return median(sizes)
}

function extractMicroReplacementByPosition(candidate, context, rectangle, scale, orientation){
    if(!candidate.words?.length) return null

    const target = context.target

    const {x: targetNaturalX, y: targetNaturalY } = estimateSingleCharacterCenter(context, orientation)

    const targetX = (targetNaturalX - rectangle.left) * scale
    const targetY = (targetNaturalY - rectangle.top) * scale

    let bestWord = null
    let bestDistance = Infinity

    for(const word of candidate.words) {
        const centerX = bboxCenterX(word.bbox)
        const centerY = bboxCenterY(word.bbox)

        const distance = Math.hypot(centerX - targetX, centerY - targetY)

        if(distance < bestDistance){
            bestDistance = distance
            bestWord = word
        }
    }
    if(!bestWord) return null

    const estimatedSize = Math.max(12, estimateLineThickness(context, orientation))

    const maxDistance = estimatedSize * scale * 1.25

    if(bestDistance > maxDistance) return null

    const text = bestWord.text?.trim()

    if(!text) return null
    const originalLength = [...target.text].length
    const candidateLength = [...text].length
    
    if(originalLength === 1 && candidateLength !== 1) return null

    if(originalLength > 1 && Math.abs(candidateLength - originalLength) > 1) return null

    return {
        replacement: text,
        confidence: Number(bestWord.confidence) || 0,
        distance: bestDistance,
    }
}

function estimateSingleCharacterCenter(context, orientation){
    const target = context.target
    const references = getReliableLineWords(context)
    
    if(orientation === "vertical"){
        const centersX = references.map(word => bboxCenterX(word.bbox)).filter(Number.isFinite)
        return {
            x: centersX.length ? median(centersX) : bboxCenterX(context.lineBBox || target.bbox),
            y: bboxCenterY(target.bbox)
        }   
    }

    const centersY = references.map(word => bboxCenterY(word.bbox)).filter(Number.isFinite)

    return {
        x: bboxCenterX(target.bbox),
        y: centersY.length ? median(centersY) : bboxCenterY(context.lineBBox || target.bbox)
    }
}

function createSingleCharacterRectangle(context,imgElement,orientation){
    const target = context.target

    const lineThickness = estimateLineThickness(context, orientation)

    const charSize = Math.max(12, lineThickness)

    const {x: centerX, y: centerY} = estimateSingleCharacterCenter(context, orientation)

    const cropSize = charSize * 1.15
    const half = cropSize / 2
    const left = Math.max(0, Math.floor(centerX - half))
    const top = Math.max(0, Math.floor(centerY - half))
    const right = Math.min(imgElement.naturalWidth, Math.ceil(centerX + half))
    const bottom = Math.min(imgElement.naturalHeight, Math.ceil(centerY + half))

    return {
        left,
        top,
        width: Math.max(1, right - left),
        height: Math.max(1, bottom - top)
    }
}

async function recognizeSingleCharacterFallback(imgElement, region, context, selectedLang){
    const rectangle = createSingleCharacterRectangle(context, imgElement, region.orientation)
    const scale = 8
    const rawCanvas = createUpScaledRegionCanvas(imgElement, rectangle, scale)
    const contrastCanvas = cloneCanvas(rawCanvas)
    const otsuCanvas = cloneCanvas(rawCanvas)
    
    applyGrayscaleAndContrast(contrastCanvas, 1.35)
    applyOtsuThreshold(otsuCanvas)

    const psm = Tesseract.PSM.SINGLE_CHAR
    const {worker, language} = await getRefinementWorker(getBaseLanguage(selectedLang), "horizontal")
    const raw = await recognizeRefinementCanvas(worker, rawCanvas, language, selectedLang, psm)
    const contrast = await recognizeRefinementCanvas(worker, contrastCanvas, language, selectedLang, psm)
    const otsu = await recognizeRefinementCanvas(worker, otsuCanvas, language, selectedLang, psm)

    return {
        raw,
        contrast,
        otsu,
        rectangle,
        scale
    }
}

function extractSingleCharacterCandidate(candidate, selectedLang, originalText){
    if(!candidate?.text) return null

    const normalized = normalizeOCRText(candidate.text, selectedLang).replace(/\s+/g, "")
    const characters = [...normalized].filter(char => /[\p{L}\p{N}]/u.test(char))

    if(characters.length !== 1) return null

    const replacement = characters[0]

    if(!isCompatibleCharacterReplacement(originalText, replacement)) return null

    const confidence = candidate.words?.length === 1 
        ? candidate.words[0].confidence
        : candidate.confidence

    return {
        replacement,
        confidence: Number(confidence) || 0
    }
}

function selectSingleCharacterFallback(fallback, selectedLang, originalText){
    
    const sources = [
        {
            name: "raw",
            data: fallback.raw
        },
        {
            name: "contrast",
            data: fallback.contrast
        },
        {
            name: "otsu",
            data: fallback.otsu
        }
    ]

    const candidates = sources.map(source => {
        const candidate = extractSingleCharacterCandidate(source.data,selectedLang,originalText)
        if(!candidate) return null

        return{...candidate, source: source.name}
    }).filter(Boolean)

    if(!candidates.length) return null

    const groups = new Map()

    for(const candidate of candidates){
        if(!groups.has(candidate.replacement)){
            groups.set(candidate.replacement, [])
        }
        groups.get(candidate.replacement).push(candidate)
    }

    const majority = [...groups.entries()].map(([replacement, votes]) => ({
        replacement, votes
    })).filter(group => group.votes.length >= 2).sort((a,b) => b.votes.length - a.votes.length)[0]

    if(majority){
        const confidence = Math.min(...majority.votes.map(vote => vote.confidence))

        if(confidence >= 60){
            return {
                replacement: majority.replacement,
                confidence,
                consensus: true,
                method: "single-char-majority",
                votes: majority.votes.map(vote => vote.source),
                scale: fallback.scale,
                rectangle: fallback.rectangle
            }
        }
    }

    const ordered = [...candidates].sort((a,b) => b.confidence - a.confidence)
    const best = ordered[0]
    const second = ordered[1]

    if(best.confidence < 92) return null

    if(second && (best.confidence - second.confidence) < 15) return null

    return {
        replacement: best.replacement,
        confidence: best.confidence,
        consensus: false,
        method: `single-char-${best.source}`,
        scale: fallback.scale,
        rectangle: fallback.rectangle
    }
}

function isReliableMicroResult(result, originalText){
    if(!result?.replacement || result.replacement === originalText) return false

    if(result.consensus === true){
        return (result.confidence >= 60)
    }
    return (result.confidence >= 85)
}

function getCharacterScript(char){
    if(/\p{Script=Han}/u.test(char)){
        return "han"
    }
    if(/\p{Script=Hiragana}/u.test(char)){
        return "hiragana"
    }
    if(/\p{Script=Katakana}/u.test(char)){
        return "katakana"
    }
    if(/\p{Script=Hangul}/u.test(char)){
        return "hangul"
    }
    if(/\p{N}/u.test(char)){
        return "number"
    }
    if(/\p{L}/u.test(char)){
        return "letter"
    }
    return "other"
}

function isCompatibleCharacterReplacement(original,replacement){
    const originalChars = [...original]
    const replacementChars = [...replacement]

    if(originalChars.length !== 1 || replacementChars.length !== 1) return false

    const originalScript = getCharacterScript(originalChars[0])
    const replacementScript = getCharacterScript(replacementChars[0])

    return (originalScript === replacementScript)
}

async function recognizeMicroContext(imgElement, region, context, selectedLang, worker, language){
    const rectangle = createMicroRefinementRectangle(context, imgElement, region.orientation)

    if(!rectangle) return null

    const scale = calculateMicroOCRScale(context, region.orientation)
    const rawCanvas = createUpScaledRegionCanvas(imgElement, rectangle, scale)
    const contrastCanvas = cloneCanvas(rawCanvas)

    applyGrayscaleAndContrast(contrastCanvas, 1.35)

    const psm = region.orientation === "vertical"
        ? Tesseract.PSM.SINGLE_BLOCK_VERT_TEXT
        : Tesseract.PSM.SINGLE_LINE

    const raw = await recognizeRefinementCanvas(worker, rawCanvas, language, selectedLang, psm)
    const contrast = await recognizeRefinementCanvas(worker, contrastCanvas, language, selectedLang, psm)
    const candidates = [
        {
            ...raw,
            preprocessing: "micro-raw"
        },
        {
            ...contrast,
            preprocessing: "micro-contrast"
        }
    ]

    const replacements = candidates.map(candidate => {
        
        let replacement = extractMicroReplacement(candidate.text, context, selectedLang)
        let method = "context"
        let replacementConfidence = candidate.confidence
        let distance = null
        if(!replacement){
            const positional = extractMicroReplacementByPosition(candidate, context,rectangle, scale, region.orientation)

            if(positional) {
                replacement = positional.replacement
                replacementConfidence = positional.confidence
                distance = positional.distance
                method = "position"
            }
        }

        return {
            ...candidate,
            replacement,
            replacementConfidence,
            distance,
            extractionMethod: method
        }

    }).filter(candidate => candidate.replacement)

    console.log("OCR micro candidates: ",
        {
            target: context.target.text,
            originalConfidence: context.target.confidence,
            candidates: candidates.map(candidate => ({
                preprocessing: candidate.preprocessing,
                text: candidate.text,
                confidence: candidate.confidence,
                words: candidate.words?.map(word => ({
                    text: word.text,
                    confidence: word.confidence,
                    bbox: word.bbox
                }))
            })),
            replacements:
                replacements.map(candidate => ({
                    text: candidate.replacement,
                    method: candidate.extractionMethod,
                    confidence: candidate.replacementConfidence,
                    distance: candidate.distance
                }))
        }
    )

    if(!replacements.length) return null

    if(replacements.length >= 2 && replacements[0].replacement === replacements[1].replacement){

        const consensusConfidence = Math.min(replacements[0].replacementConfidence, replacements[1].replacementConfidence,)

        if(consensusConfidence >= 60){
            return {
                replacement: replacements[0].replacement,
                confidence: consensusConfidence,
                consensus: true,
                candidates,
                rectangle,
                scale
            }
        }
    }

    const best = [...replacements].sort((a,b) => b.replacementConfidence - a.replacementConfidence)[0]

    if(best.replacementConfidence < 80) return null

    return {
        replacement: best.replacement,
        confidence: best.replacementConfidence,
        consensus: false,
        candidates,
        rectangle,
        scale
    }
}

async function microRefineLowConfidenceWords(imgElement, region, selectedLang, worker, language){

    if(!isStructurallyReliableRegion(region)){
        return {
            text: region.text,
            corrections: []
        }
    }

    const isCJK = isCJKLanguage(selectedLang)

    const threshold = isCJK ? 35 : 30

    const maxWords = isCJK ? 4 : 3

    const suspicious = getLowConfidenceWords(region, threshold, maxWords)
    
    if(!suspicious.length){
        return {
            text: region.text,
            corrections: []
        }
    }

    const overrides = new Map()
    const corrections = []

    for(const {word, line} of suspicious){
        const context = getWordContext(line,word, 1)

        if(!context) continue

        let result = await recognizeMicroContext(imgElement, region, context,selectedLang, worker, language)

        const originalLength = [...word.text].length
        const scriptCompatible = originalLength !== 1 
            || !isCJKLanguage(selectedLang)
            || !result?.replacement
            || isCompatibleCharacterReplacement(word.text, result.replacement) 
        const microSolved = scriptCompatible && isReliableMicroResult(result, word.text)

        if(!microSolved && originalLength === 1 && isCJKLanguage(selectedLang)){
            console.log("Micro OCR inconclusive. " +
                "Trying SINGLE_CHAR:", {
                    text: word.text,
                    confidence: word.confidence,
                    orientation: region.orientation
                }
            )
            const fallback = await recognizeSingleCharacterFallback(imgElement, region, context, selectedLang)
            const fallbackResult = selectSingleCharacterFallback(fallback, selectedLang, word.text)

            console.log("SINGLE_CHAR candidates:", {
                    original: word.text,
                    orientation: region.orientation,
                    rectangle: fallback.rectangle,
                    scale: fallback.scale,
                    raw: { 
                        text: fallback.raw.text,
                        confidence: fallback.raw.confidence,
                        words: fallback.raw.words
                    },
                    contrast: {
                        text: fallback.contrast.text,
                        confidence: fallback.contrast.confidence,
                        words: fallback.contrast.words
                    },
                    otsu: {
                        text: fallback.otsu.text,
                        confidence: fallback.otsu.confidence,
                        words: fallback.otsu.words
                    }
            })

            

            if(fallbackResult){
                console.log("SINGLE_CHAR result:", {
                    original: word.text,
                    replacement: fallbackResult.replacement,
                    confidence: fallbackResult.confidence,
                    consensus: fallbackResult.consensus,
                    method: fallbackResult.method
                })
            }
            result = fallbackResult || null
        }

        if(!result?.replacement) continue

        const finalScriptCompatible = originalLength !== 1
            || !isCJKLanguage(selectedLang)
            || isCompatibleCharacterReplacement(word.text, result.replacement)

        if(!finalScriptCompatible) continue

        if(!isReliableMicroResult(result, word.text)) continue

        if(result.replacement === word.text) continue

        const key = getOCRWordKey(word)

        overrides.set(key, result.replacement)

        corrections.push({
            wordKey: key,
            original: word.text,
            replacement: result.replacement,
            originalConfidence: word.confidence,
            microConfidence: result.confidence,
            consensus: result.consensus,
            scale: result.scale,
            bbox: word.bbox,
            method: result.method || "micro-context"
        })
    }

    const lineTexts = region.lines.map(line => {
        const separator = usesNoWordSpaces(selectedLang) ? "" : " "

        return (line.words || []).map(word => {
            const key = getOCRWordKey(word)

            return (overrides.get(key) ?? word.text)
        }).join(separator)
    })

    const regionSeparator = usesNoWordSpaces(selectedLang) ? "" : " "
    const text = lineTexts.join(regionSeparator)

    return {text, corrections}

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

async function refineTextRegions(regions, imgElement, selectedLang){
    const refinedRegions = []

    for(const region of regions){
        if(isProbablyNoiseRegion(region, selectedLang)){
            refinedRegions.push(region) 
            continue
        }

        const shouldRefine = isCJKLanguage(selectedLang)
            || region.confidence < 92 
            || region.lines?.length > 1

        if(!shouldRefine){
            refinedRegions.push(region)
            continue
        }

        try{
            const refined = await recognizeRegionSecondPass(imgElement,region,selectedLang)
            const useRefined = shouldUseRefinedOCR(region,refined,selectedLang)
            console.log("OCR second pass: ",{
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
                confidence: useRefined ? refined.confidence : region.confidence
            })
        }catch(e) {
            console.warn("Second OCR pass failed: ", e)
            refinedRegions.push(region)
        }
    }
    return refinedRegions
}

async function recognizeRegionSecondPass(imgElement, region, selectedLang){
    const {worker, language} = await getRefinementWorker(selectedLang, region.orientation)
    const microFirstPass = await microRefineLowConfidenceWords(imgElement, region, selectedLang, worker, language)
    const psm = getRefinementPSM(region)
    const rectangle = createRefinementRectangle(region, imgElement)

    const scale = calculateOCRScale(region)

    const rawCanvas = createUpScaledRegionCanvas(imgElement, rectangle, scale)
    const processedCanvas = cloneCanvas(rawCanvas)
    

    applyGrayscaleAndContrast(processedCanvas, 1.4)

    const raw = await recognizeRefinementCanvas(worker, rawCanvas, language, selectedLang, psm)
    
    const processed = await recognizeRefinementCanvas(worker, processedCanvas, language, selectedLang, psm)

    const baseFirstPassCandidate = {
        text: region.text,
        layoutText: region.rawText,
        words: region.lines.flatMap(line => line.words || []),
        confidence: region.confidence,
        preprocessing: "first-pass",
        microCorrections: [],
        scale: 1
    }

    const candidates = [baseFirstPassCandidate]
    const microAdjustedConfidence = calculateMicroAdjustedConfidence(region, microFirstPass.corrections)

    if(microFirstPass.corrections.length){
        candidates.push({
            text: microFirstPass.text,
            layoutText: region.rawText,
            words: region.lines.flatMap(line => line.words || []),
            confidence: microAdjustedConfidence,
            preprocessing: "first-pass+micro",
            microCorrections: microFirstPass.corrections,
            scale: 1
        })
    }

    candidates.push(
        {
            ...raw,
            preprocessing: "raw",
            scale
        },
        {
            ...processed,
            preprocessing: "contrast",
            scale
        }
    )

    if(needsAggressiveRefinement(candidates)){
        const aggressiveScale = Math.min(6, Math.max(scale, scale * 1.25))
        const otsuCanvas = createUpScaledRegionCanvas(imgElement, rectangle, aggressiveScale)

        applyOtsuThreshold(otsuCanvas)

        const otsu = await recognizeRefinementCanvas(
            worker,
            otsuCanvas,
            language,
            selectedLang,
            psm
        )

        candidates.push({
            ...otsu,
            preprocessing: "otsu",
            scale: aggressiveScale
        })
    }
    const hasStrongMicroCorrection = microFirstPass.corrections.length > 0
        && microFirstPass.corrections.every( correction =>
            correction.consensus === true && correction.microConfidence >= 70
        )
    const scoreReferenceText = hasStrongMicroCorrection ? microFirstPass.text : region.text
    const best = selectBestOCRCandidate(candidates, scoreReferenceText)

    console.log("OCR refinement candidates: ", 
        candidates.map(candidate => ({
            preprocessing: candidate.preprocessing,
            text: candidate.text,
            confidence: candidate.confidence,
            scale: candidate.scale,
            microCorrections: candidate.microCorrections || [],
            score: scoreOCRCandidate(candidate, scoreReferenceText, candidates)
        }))
    )
    console.log("OCR  refinement winner: ",
        {
            preprocessing: best.preprocessing,
            text: best.text,
            confidence: best.confidence,
            score: best.score,
            scale: best.scale
        }
    )

    if(microFirstPass.corrections.length){
        console.log("OCR micro-refinement: ", microFirstPass.corrections)
    }
    

    return {
        text: best.text,
        layoutText: best.layoutText,
        confidence: best.confidence,
        words: best.words,
        preprocessing: best.preprocessing,
        microCorrections: best.microCorrections || [],
        scale: best.scale,
        score: best.score,
        candidates,
        language,
        psm,
        rectangle
    }
}

async function readImage(imageTarget, selectedLang, mode = OCR_MODE.AUTO){
    const languages = getOCRLanguages(selectedLang)

    console.log("OCR Language: ", {selected: selectedLang, loaded: languages})

    const worker = await getOCRWorker(selectedLang)

    
    if(mode === OCR_MODE.MANGA){
        return await recognizeWorker(worker, imageTarget, Tesseract.PSM.SPARSE_TEXT)
    }


    if(mode === OCR_MODE.DOCUMENT){
        return await recognizeWorker(worker, imageTarget, Tesseract.PSM.AUTO)
    }

    const autoResult = await recognizeWorker(worker, imageTarget, Tesseract.PSM.AUTO)

    const shouldRetrySparse = inspectSparseMode(
        autoResult,
        selectedLang
    )

    if(!shouldRetrySparse) return autoResult

    console.log("AUTO pouco confiavel. Testando SPARSE_TEXT...")

    const sparseResult = await recognizeWorker(worker, imageTarget, Tesseract.PSM.SPARSE_TEXT)
    const useSparse = shouldPreferSparseResult(autoResult, sparseResult, selectedLang)

    console.log("OC initial mode comparison: ", 
        {
            auto: getOCRResultStats(autoResult, selectedLang),
            sparse: getOCRResultStats(sparseResult, selectedLang),
            selected: useSparse ? "SPARSE_TEXT" : "AUTO"
        }
    )

    return useSparse ? sparseResult : autoResult
    
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

function isStructurallyReliableRegion(region){
    if(!region.lines?.length) return false

    const words = region.lines.flatMap(line => line.words || [])

    if(!words.length) return false

    const veryLowConfidence = words.filter(word => 
        (Number(word.confidence) || 0) < 15).length

    const ratio = veryLowConfidence / words.length

    return ratio < 0.25
}

function normalizeForComparison(text){
    return (text || "").replace(/\s+/g, "").trim()
}

function scoreOCRCandidate(candidate, firstPassText, allCandidates = []){
    if(!candidate.text) return -Infinity

    let score = Number(candidate.confidence) || 0

    const candidateText = normalizeForComparison(candidate.text)
    const firstText = normalizeForComparison(firstPassText)
    const candidateLength = [...candidateText].length
    const originalLength = [...firstText].length

    if(originalLength > 0){
        const ratio = candidateLength / originalLength

        if(ratio < 0.6){
            score -= 40
        }else if(ratio < 0.75){
            score -= 20
        }

        if(ratio >= 0.85 && ratio <= 1.15){
            score += 5
        }
    }

    if(candidateText && candidateText === firstText){
        score += 8
    }

    for(const other of allCandidates){
        if(other === candidate) continue

        const otherText = normalizeForComparison(other.text)

        if(candidateText && candidateText === otherText){
            score += 10
        }
    }

    if(candidate.preprocessing === "raw"){
        score += 1
    }

    if(candidate.preprocessing === "otsu"){
        score -= 1
    }

    if(candidate.microCorrections?.length) {
        for(const correction of candidate.microCorrections){
            if(correction.consensus){
                score += 5
            }else{
                score += 2
            }
        }
    }

    return score
}

function selectBestOCRCandidate(candidates, firstPassText){
    return [...candidates]
    .map(candidate => ({...candidate, score: scoreOCRCandidate(candidate, firstPassText, candidates)}))
    .sort((a, b) => b.score - a.score)[0]
}

function calculateOCRScale(region){
    if(!region.lines?.length) return 3

    const sizes = region.lines.map(line => {
        if(line.orientation === "vertical"){
            return bboxWidth(line.bbox)
        }
        return bboxHeight(line.bbox)
    })

    const averageSize = averageBbox(sizes)
    const targetSize = 60
    const scale = targetSize / Math.max(averageSize, 1)

    return Math.max(2, Math.min(5, scale))
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
            console.log("OCR Noise Removed: ", {
                text: word.text, confidence: word.confidence
            })
            return
        }
        words.push(word)
    })
    return words
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

    const horizontalGap = axisGap(regionBox.x0, regionBox.x1, lineBox.x0, lineBox.x1)
    const verticalOverlap = overlapRatio(regionBox.y0, regionBox.y1, lineBox.y0, lineBox.y1)
    const centerDifference = Math.abs(bboxCenterY(regionBox) - bboxCenterY(lineBox))
    const maxHeight = Math.max(bboxHeight(regionBox), bboxHeight(lineBox))
    const maxGap = Math.max(regionThickness, lineThickness) * 1.7

    if(usesNoWordSpaces(selectedLang) && verticalOverlap > 0.55){
        const cjkMaxGap = Math.max(regionThickness, lineThickness) * 2.5

        return (horizontalGap <= cjkMaxGap)
    }

    return (horizontalGap <= maxGap && 
        (verticalOverlap > 0.15 || centerDifference < maxHeight * 0.40))
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

async function drawTranslationBlocks(ocrData, imgElement, selectedLang){


    const {words, lines, regions: firstPassRegions} = buildOCRStructure(ocrData, selectedLang)

    console.log("OCR words: ", words)
    console.log("OCR lines: ", lines)
    console.log("OCR first-pass regions: ", firstPassRegions)

    const regions = await refineTextRegions(firstPassRegions, imgElement, selectedLang)

    if(regions.length === 0) {
        console.warn("No region found") 
        return
    }

    const naturalWidth = imgElement.naturalWidth
    const naturalHeight = imgElement.naturalHeight

    if(!naturalWidth || !naturalHeight) {
        console.warn("No natural image dimentions") 
        return
    }

    const overlay = createImageOverlay(imgElement)

    regions.forEach((region, index) => {

        if(isProbablyNoiseRegion(region, selectedLang)){
            console.log("OCR region removed as noise:", region)
            return
        }

        const originalText = region.text.trim();

        if(!originalText) return
        if(!isCJKLanguage(selectedLang) && originalText.length < 2) return;

        const bbox = region.bbox
        const leftBox = (bbox.x0 / naturalWidth) * 100
        const topBox = (bbox.y0 / naturalHeight) * 100
        const widthBox = ((bbox.x1 - bbox.x0) / naturalWidth) * 100
        const heightBox = ((bbox.y1 - bbox.y0) / naturalHeight) * 100

        console.log(`Region ${index}: `, 
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

        if(region.orientation === "vertical" && usesNoWordSpaces(selectedLang)){
            balon.style.writingMode = "vertical-rl"
            balon.style.textOrientation = "upright"
        }

        balon.innerText = originalText

        overlay.appendChild(balon)
    })
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

            chrome.storage.local.get(['langFrom'], async (data) => {
                
                const language = data.langFrom

                if(!language){
                    console.error("Nenhum idiona de origem configurado")
                    translationBtn.innerText = "No language"
                    return
                }

                const runId = ++ocrRunId
                const targetImage = currentImage

                if(!targetImage) return

                try{

                    const ocrData = await readImage(targetImage, language, OCR_MODE.AUTO)
                    console.log('Dados extraidos: ', ocrData)

                    if(runId !== ocrRunId) return

                    await drawTranslationBlocks(ocrData, targetImage, language)

                    if(runId !== ocrRunId){
                        removeImageOverlay(targetImage)
                        return
                    }

                    translationBtn.innerText = 'Done'
                }catch(e){
                    if(runId !== ocrRunId) return
                    console.error('Erro no Tesseract: ', e)
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