const LANGUAGE_NAMES = {
    jpn: "Japanese",
    kor: "Korean",
    chi_sim: "Simplified Chinese",
    chi_tra: "Tradicional Chinese",
    eng: "English",
    por: "Portuguese",
    spa: "Spanish"
}
const TRANSLATION_SCHEMA = {
    type: "object",
    properties: {
        correctedText: {
            type: "string"
        },
        translation: {
            type: "string"
        },
        corrections: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    from: {
                        type: "string"
                    },
                    to: {
                        type: "string"
                    }
                },
                required: [
                    "from",
                    "to"
                ]
            }
        }
    },
    required: [
        "correctedText",
        "translation",
        "corrections"
    ]
}

const OLLAMA_CONFIG = {
    baseUrl: "http://127.0.0.1:11434",
    model: "kaelri/hy-mt2:7b",
    timeout: 120000,
    keepAlive: "2m",
    warmupKeepAlive: "30s",
    numCtx: 1024
}

let warmupPromise = null

function getLanguageName(language){
    return (LANGUAGE_NAMES[language] || language)
}

function buildTranslationPrompt({
    text, sourceLanguage, targetLanguage, lowConfidenceWords = [], context = ""
}){
    const source = getLanguageName(sourceLanguage)
    const target = getLanguageName(targetLanguage)
    const suspiciousText = lowConfidenceWords.length ? lowConfidenceWords.map(word =>
        `${word.text} (${Math.round(word.confidence)}%)`
    ).join(", ") : "None"

    return `
        Translate the OCR-extracted text from ${source} to ${target}.

        The text was extracted from an image using OCR and may contain a small number of incorrectly recognized characters.

        Translation requirements:

        - Translate faithfully and naturally.
        - Preserve the original meaning.
        - Preserve the speaker's tone and personality.
        - Preserve profanity, insults, slang, vulgar language and adult language.
        - Do not censor, sanitize or soften the source text.
        - Correct OCR errors only when the surrounding context makes the correction highly probable.
        - If you are uncertain whether a character is an OCR error, leave it unchanged.
        - Do not invent missing sentences.
        - Preserve names and proper nouns whenever possible.

        OUTPUT FIELD RULES:

        - "correctedText":
        The OCR text after correcting obvious OCR mistakes.
        It MUST remain in ${source}.
        NEVER translate correctedText into ${target}.

        - "translation":
        The translation of correctedText into ${target}.
        It MUST contain the translated text when the input contains text.
        Do NOT leave translation empty.

        - "corrections":
        Only list actual OCR corrections.
        "from" and "to" must refer to the source-language OCR text.

        OCR characters with unusually low confidence:
        ${suspiciousText}

        Additional context:
        ${context || "None"}

        OCR text:
        ${text}

        Return only the requested structured response.
    `.trim()
}

function buildBatchTranslationSchema(items){
    const itemSchema = {
        type: "object",
        properties: {
            t: {
                type: "string"
            }
        },
        required: ["t"],
        additionalProperties: false
    }

    const properties = {}
    const required = []

    for(const item of items){
        const key = String(item.index)
        properties[key] = itemSchema
        required.push(key)
    }

    return {
        type: "object",
        properties: {
            items: {
                type: "object",
                properties,
                required,
                additionalProperties: false
            }
        },
        required: ["items"],
        additionalProperties: false
    }
}

function buildBatchTranslationPrompt({items, sourceLanguage, targetLanguage}){
    const source = getLanguageName(sourceLanguage)
    const target = getLanguageName(targetLanguage)
    const compactItems = items.map(item => [item.index, item.text])

    return `
        Translate manga OCR text from ${source} to ${target}.

        All items are from the same manga page.
        Use neighboring items as context, but translate each item independently.

        The input comes from OCR and may contain minor recognition errors.
        Infer only unquestionably obvious OCR mistakes while translating.
        Do not rewrite or return the source text.

        Rules:
        - Preserve meaning and tone.
        - Preserve slang, profanity and adult language.
        - Preserve names and proper nouns.
        - Translate the COMPLETE content of every item from beginning to end.
        - Never shorten, summarize, abbreviate or omit any clause.
        - If an item contains multiple phrases or sentences, translate all of them.
        - Every meaningful part of the source must be represented in "t".
        - Never invent text.
        - Never merge or reorder items.
        - "t" must be the complete ${target} translation.
        - "t" must not be empty.

        Input format:
        [index, OCR text]

        Input:
        ${JSON.stringify(compactItems)}

        Output format:

        "items" is an object.

        Each input index is already defined as a key in the required structured output.

        For each key:
        - "t" = complete ${target} translation

        Do not invent indexes.
        Do not omit indexes.
        Do not change the keys.
        Fill every required item.

        Return only the structured response.
    `.trim()
}

async function ollamaFetch(endpoint, options = {}){
    const controller = new AbortController()
    const timeout = setTimeout(() => {
        controller.abort()
    }, OLLAMA_CONFIG.timeout)

    try{
        const response = await fetch(`${OLLAMA_CONFIG.baseUrl}${endpoint}`,
            {
                ...options,
                signal: controller.signal
            }
        )
        if(!response.ok){
            const errorText = await response.text()

            throw new Error(`Ollama HTTP ${response.status}: ${errorText}`)
        }
        return response
    }catch(error){
        if(error.name === "AbortError"){
            throw new Error("Ollama request timeout")
        }

        throw error
    }finally {
        clearTimeout(timeout)
    }
}

export async function getOllamaModels(){
    const response = await ollamaFetch("/api/tags", {method: "GET"})
    const data = await response.json()

    return (data.models || [])
}

export async function isOllamaAvailable(){
    try{
        await getOllamaModels()

        return true
    }catch(error){
        console.warn("Ollama Unavailable", error)
    }
    return false
}

export async function isTranslationModelInstalled(){
    const models = await getOllamaModels()

    return models.some(
        item => item.name === OLLAMA_CONFIG.model || item.model === OLLAMA_CONFIG.model
    )
}

export async function warmUpTranslationModel(){

    if(warmupPromise) return warmupPromise

    warmupPromise = (async () => {

        const StartedAt = performance.now()

        const response = await ollamaFetch("/api/chat", {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                model:OLLAMA_CONFIG.model,
                messages: [],
                stream: false,
                keep_alive: OLLAMA_CONFIG.warmupKeepAlive,
                options: { num_ctx: OLLAMA_CONFIG.numCtx}
            })
        })  

        const data = await response.json()

        const result = {
            model: data.model || OLLAMA_CONFIG.model,
            elapsedMs: Math.round(performance.now() - StartedAt),
            totalDurationMs: data.total_duration ? Math.round(data.total_duration / 1_000_000) : null,
            loadDurationMs: data.load_duration ? Math.round(data.load_duration / 1_000_000) : null,
        }

        console.log("Ollama warmup ready:", result)

        return result
    
    })()

    try{
        return await warmupPromise
    }finally{
        warmupPromise = null
    }
}

export async function unloadTranslationModel(){
    if(warmupPromise){
        try{
            await warmupPromise
        }catch(e){
            console.warn("Warmup failed before unload: ", e)
        }
    }
    const response = await ollamaFetch("/api/generate", {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            model:OLLAMA_CONFIG.model,
            stream: false,
            keep_alive: 0,
        })
    })  

    const data = await response.json()
    console.log("Ollama model unloaded: ", data)

    return {
        model: data.model || OLLAMA_CONFIG.model,
        unloaded: true
    }


}

export async function translateBatchWithOllama({items, sourceLanguage="jpn",targetLanguage="eng"}){
    if(warmupPromise){
        try{
            await warmupPromise
        }catch(e){
            console.warn("Ollama warmup failed before batch translation: ", e)
        }
    }
    if(!Array.isArray(items) || items.length === 0) throw new Error("No items provided for batch translation")

    const validItems = items.filter(item => item.text?.trim())

    if(validItems.length === 0){
        return { items: [] }
    }

    const prompt = buildBatchTranslationPrompt({items: validItems, sourceLanguage, targetLanguage})
    const body = {
        model: OLLAMA_CONFIG.model,
        messages: [{
            role: "user",
            content: prompt
        }],
        stream: false,
        format: buildBatchTranslationSchema(validItems),
        keep_alive: OLLAMA_CONFIG.keepAlive,
        options: {
            temperature: 0.1,
            top_p: 0.6,
            top_k: 20,
            repeat_penalty: 1.05,
            num_ctx: OLLAMA_CONFIG.numCtx,
            num_predict: 512
        }
    }
    const response = await ollamaFetch("/api/chat", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify(body)
    })
    const data = await response.json()
    const content = data.message?.content

    if(!content) throw new Error("Ollama returned an empty batch response")

    let result

    try{
        result = JSON.parse(content)
    }catch(e){
        console.error("Invalid Ollama batch JSON: ", content)
        throw new Error("Ollama returned invalid batch JSON")
    }

    const outputItems = result.items && typeof result.items === "object" && !Array.isArray(result.items)
        ? result.items : {}

    const normalizedItems = validItems.map(sourceItem => {
        const key = String(sourceItem.index)
        const translated = outputItems[key]
        const translation = typeof translated?.t === "string"
            ? translated.t.trim()
            : ""

        return {
            index: sourceItem.index,
            correctedText: sourceItem.text,
            translation,
            corrections: [],
            needsFallback: !translated || !translation
        }
    })

    return {
        items: normalizedItems,
        model: data.model,
        totalDuration: data.total_duration,
        loadDuration: data.load_duration,
        promptEvalDuration: data.prompt_eval_duration,
        evalDuration: data.eval_duration,
        evalCount: data.eval_count,
        rawItemCount: Object.keys(outputItems).length,
        fallbackCount: normalizedItems.filter(item => item.needsFallback).length,
        doneReason: data.done_reason,
        rawOutputItems: Object.entries(outputItems).map(([index, item]) => ({
            i: Number(index),
            translation: item?.t || ""
        }))
    }

}

export async function translateWithOllama({
    text,
    sourceLanguage = "jpn",
    targetLanguage = "eng",
    lowConfidenceWords = [],
    context = ""
}){

    if(warmupPromise){
        try{
            await warmupPromise
        }catch(e){
            console.warn("Ollama warmup failed before translation: ", e)
        }
    }

    if(!text || !text.trim()){
        throw new Error("No text provided for translation")
    }

    const prompt = buildTranslationPrompt({
        text,
        sourceLanguage,
        targetLanguage,
        lowConfidenceWords,
        context
    })

    const body = {
        model: OLLAMA_CONFIG.model,
        messages: [{
            role: "user",
            content: prompt
        }],
        stream: false,
        format: TRANSLATION_SCHEMA,
        keep_alive: OLLAMA_CONFIG.keepAlive,
        options: {
            temperature: 0.1,
            top_p: 0.6,
            top_k: 20,
            repeat_penalty: 1.05,
            num_ctx: OLLAMA_CONFIG.numCtx,
            num_predict: 256
        }
    }

    const response = await ollamaFetch("/api/chat", 
        {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(body)}
    )

    const data = await response.json()
    const content = data.message?.content
    
    if(!content) throw new Error("Ollama returned an empty response")

    let result

    try{
        result = JSON.parse(content)
    }catch(e){
        console.error("Invalid Ollama JSON:", content)

        throw new Error("Ollama returned invalid JSON")
    }

    return {
        correctedText: result.correctedText || text,
        translation: result.translation || "",
        corrections: Array.isArray(result.corrections)
            ? result.corrections
            : [],
        model: data.model,
        totalDuration: data.total_duration,
        evalCount: data.eval_count
    }
}