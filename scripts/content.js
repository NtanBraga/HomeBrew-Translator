import Tesseract from "tesseract.js";

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

function inspectSparseMode(ocrData, imageWidth, imageHeight){
    if(!ocrData.blocks?.length) return true
    if(ocrData.blocks.length > 1) return false

    const block = ocrData.blocks[0]
    const bbox = block.bbox

    if(!bbox) return true


    const blockWidth = bbox.x1 - bbox.x0
    const blockHeight = bbox.y1 - bbox.y0

    const blockArea = blockWidth * blockHeight
    const imageArea = imageWidth * imageHeight

    const coverage = blockArea / imageArea

    const lineCount = block.paragraphs?.reduce(
        (total, paragraph) => total + (paragraph.lines?.length || 0), 0
    ) || 0

    return (coverage > 0.60 && lineCount >= 3)
}

async function recognizeWorker(worker, imageTarget, psm) {

    await worker.setParameters({
        tessedit_pageseg_mode: psm
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

async function readImage(imageTarget, selectedLang, mode = OCR_MODE.AUTO){
    const languages = getOCRLanguages(selectedLang)

    console.log("OCR Languages: ", languages)

    const worker = await Tesseract.createWorker(languages)

    try{
        if(mode === OCR_MODE.MANGA){
            return await recognizeWorker(worker, imageTarget, Tesseract.PSM.SPARSE_TEXT)
        }


        if(mode === OCR_MODE.DOCUMENT){
            return await recognizeWorker(worker, imageTarget, Tesseract.PSM.AUTO)
        }

        let result = await recognizeWorker(worker, imageTarget, Tesseract.PSM.AUTO)

        const shouldRetrySparse = inspectSparseMode(
            result,
            imageTarget.naturalWidth,
            imageTarget.naturalHeight 
        )

        if(shouldRetrySparse) {
            console.log("Layout disperso detectado.." + "Tentando SPARSE_TEXT..")

            result = await recognizeWorker(worker, imageTarget, Tesseract.PSM.SPARSE_TEXT)
        }
        return result
    } finally {
        await worker.terminate()
    }
}

function extractOCRWords(ocrData){
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

        words.push({
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
        })
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

    lineMap.forEach((lineWords, key) => {
        const bbox = calculateBoundingBox(lineWords)
        const orientation = detectLineOrientation(lineWords, bbox, selectedLang)

        lineWords.sort((a,b) => {
            if(orientation === "vertical"){
                return (a.bbox.y0 - b.bbox.y0)
            }
            return (a.bbox.x0 - b.bbox.x0)
        })

        const separator = orientation === "vertical" && 
            isCJKLanguage(selectedLang) ? "" : " "

        const text = lineWords.map(word => word.text).join(separator)
        const confidence = averageBbox(lineWords.map(word => word.confidence))

        lines.push({
            id: key,
            text,
            words: lineWords,
            confidence,
            orientation,
            bbox,
            pageNum: lineWords[0].pageNum,
            blockNum: lineWords[0].blockNum,
            parNum: lineWords[0].parNum,
            lineNum: lineWords[0].lineNum
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

function canMergeLineIntoRegion(region,line){
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
        const centerDifference = Math.abs(bboxCenterX(regionBox) - bboxCenterX(lineBox))
        const maxWidth = Math.max(bboxWidth(regionBox),bboxWidth(lineBox))
        const maxGap = Math.max(regionThickness, lineThickness) * 1.7

        return (verticalGap <= maxGap && 
            (horizontalOverlap > 0.15 || centerDifference < maxWidth * 0.40))
    }

    const horizontalGap = axisGap(regionBox.x0, regionBox.x1, lineBox.x0, lineBox.x1)
    const verticalOverlap = overlapRatio(regionBox.y0, regionBox.y1, lineBox.y0, lineBox.y1)
    const centerDifference = Math.abs(bboxCenterY(regionBox) - bboxCenterY(lineBox))
    const maxHeight = Math.max(bboxHeight(regionBox), bboxHeight(lineBox))
    const maxGap = Math.max(regionThickness, lineThickness) * 1.7

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
            .filter(region => canMergeLineIntoRegion(region,line))
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

        if(region.orientation === "vertical" && isCJKLanguage(selectedLang)){
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
    const words = extractOCRWords(ocrData)
    const lines = buildOCRLines(words, selectedLang)
    const regions = buildTextRegions(lines, selectedLang)

    return { words, lines, regions}
}

function drawTranslationBlocks(ocrData, imgElement, selectedLang){
    const rect = imgElement.getBoundingClientRect()

    const scaleX = imgElement.naturalWidth ? (rect.width / imgElement.naturalWidth) : 1;
    const scaleY = imgElement.naturalHeight ? (rect.height / imgElement.naturalHeight) : 1;

    const {words, lines, regions} = buildOCRStructure(ocrData, selectedLang)

    console.log("OCR words: ", words)
    console.log("OCR lines: ", lines)
    console.log("OCR regions: ", regions)

    if(regions.length === 0) {
        console.warn("No region found") 
        return
    }

    regions.forEach((region, index) => {
        const originalText = region.text.trim();

        if(!originalText || originalText.length < 2) return;

        const bbox = region.bbox
        const leftBox = (bbox.x0 * scaleX)
        const topBox = (bbox.y0 * scaleY)
        const widthBox = ((bbox.x1 - bbox.x0) * scaleX)
        const heightBox = ((bbox.y1 - bbox.y0) * scaleY)

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
            left: ${rect.left + window.scrollX + leftBox}px !important;
            top: ${rect.top + window.scrollY + topBox}px !important;
            width: ${widthBox}px !important;
            height: ${heightBox}px !important;
            background-color: white !important;
            color: black;
            border-radius: 6px;
            padding: 4px;
            box-sizing: border-box;
            font-family: sans-serif;
            font-size: 12px !important;
            overflow: hidden;
            display: flex;
            align-items: center;
            justify-content: center;
            text-align: center;
            white-space: normal;
            pointer-events: none;
        `

        balon.innerText = originalText

        document.body.appendChild(balon)
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
        cursor: pointer;
        display: none;
        font-family: sans-serif;
        font-size: 14px;
        box-shadow: 0 2px 4px rgba(0,0,0,0.3)
    `
    document.body.appendChild(translationBtn)

    let currentImage = null



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
                const language = data.langFrom || 'eng'
                try{
                    const ocrData = await readImage(currentImage, language, OCR_MODE.AUTO)
                    console.log('Dados extraidos: ', ocrData)
                    drawTranslationBlocks(ocrData, currentImage, language)
                    translationBtn.innerText = 'Done'
                }catch(e){
                    console.error('Erro no Tesseract: ', e)
                    translationBtn.innerText = 'Erro'
                }
                setTimeout(() => {
                    translationBtn.style.display = 'none';
                    translationBtn.innerText = 'Traduzir';
                }, 2000)
            })
        })
}

setupImageHover()