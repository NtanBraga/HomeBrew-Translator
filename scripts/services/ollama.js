const LANGUAGE_NAMES = {
    jpn: "Japanese",
    jpn_vert: "Japanese",
    kor: "Korean",
    kor_vert: "Korean",
    chi_sim: "Simplified Chinese",
    chi_sim_vert: "Simplified Chinese",
    chi_tra: "Tradicional Chinese",
    chi_tra_vert: "Tradicional Chinese",
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
    numCtx: 2048
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

        OCR characters with unusually low confidence:
        ${suspiciousText}

        Additional context:
        ${context || "None"}

        OCR text:
        ${text}

        Return only the requested structured response.
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
        const startedAt = performance.now()
    
        const response = await ollamaFetch("/api/generate", {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                model:OLLAMA_CONFIG.model,
                prompt: "",
                stream: false,
                keep_alive: OLLAMA_CONFIG.keepAlive,
                options: {
                    num_ctx: OLLAMA_CONFIG.numCtx
                }
            })
        })  

        const data = await response.json()

        const elapsed = performance.now() - startedAt
        const result = {
            model: data.model || OLLAMA_CONFIG.model,
            elapsedMs: Math.round(elapsed),
            loadDurationNs: Number(data.load_duration) || 0,
            totalDurationNs: Number(data.total_duration) || 0
        }
        console.log("Ollama model warmed up:", result)

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
            num_predict: 1024
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