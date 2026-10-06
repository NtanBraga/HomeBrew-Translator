const DB_NAME = "HomebrewTranslatorCache"
const DB_VERSION = 1
const STORE_NAME = "mangaTranslations"
const CACHE_TTL_MS = 10 * 60 * 1000
const MAX_CACHE_ENTRIES = 60

function requestToPromise(request){
    return new Promise((resolve, reject) => {
        request.onsuccess = () => {
            resolve(request.result)
        }
        request.onerror = () => {
            reject(request.error || new Error("IndexedDB request faield"))
        }
    })
}

function transactionToPromise(transaction){
    return new Promise((resolve, reject) => {

        transaction.oncomplete = () => resolve()
        transaction.onerror = () => reject(transaction.error || new Error("IndexedDB transaction failed."))
        transaction.onabort = () => reject(transaction.error || new Error("IndexedDB transaction aborted."))
    })
}

function openCacheDatabase(){
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION)
        request.onupgradeneeded = () => {
            const database = request.result

            if(database.objectStoreNames.contains(STORE_NAME)) return

            const store = database.createObjectStore(STORE_NAME, { keyPath: "key"})

            store.createIndex("createdAt", "createdAt", { unique: false })
            store.createIndex("expiresAt", "expiresAt", { unique: false })
        }
        request.onsuccess = () => {
            resolve(request.result)
        }
        request.onerror = () => {
            reject(request.error || new Error("Falha abrindo cache IndexedDB"))
        }
    })
}
function buildCacheKey({imageHash, sourceLanguage, targetLanguage, cacheVersion}){
    if(!imageHash) throw new Error("Cache sem imageHash")

    return [cacheVersion, sourceLanguage, targetLanguage, imageHash].join(":")
    
}

async function deleteCacheEntry(database, key){
    const transaction = database.transaction(STORE_NAME, "readwrite")
    transaction.objectStore(STORE_NAME).delete(key)

    await transactionToPromise(transaction)
}

async function cleanupCache(database){
    const readTransaction = database.transaction(STORE_NAME, "readonly")
    const entries = await requestToPromise(readTransaction.objectStore(STORE_NAME).getAll())

    await transactionToPromise(readTransaction)

    const now = Date.now()
    const validEntries = entries.filter(entry => entry.expiresAt > now)
    const keyToDelete = entries.filter(entry => entry.expiresAt <= now).map(entry => entry.key)

    validEntries.sort((a, b) => a.createdAt - b.createdAt)

    const overflow = Math.max(0, validEntries.length - MAX_CACHE_ENTRIES)
    
    for(let i = 0; i < overflow; i++){
        keyToDelete.push(validEntries[i].key)
    }

    if(keyToDelete.length === 0) return

    const writeTransaction = database.transaction(STORE_NAME, "readwrite")
    const store = writeTransaction.objectStore(STORE_NAME)

    for(const key of new Set(keyToDelete)){
        store.delete(key)
    }

    await transactionToPromise(writeTransaction)
}

export async function getMangaTranslationCache({imageHash, sourceLanguage, targetLanguage, cacheVersion}){
    const database = await openCacheDatabase()

    try{
        const key = buildCacheKey({imageHash, sourceLanguage, targetLanguage, cacheVersion})

        const transaction = database.transaction(STORE_NAME,"readonly")

        const entry = await requestToPromise(transaction.objectStore(STORE_NAME).get(key))

        await transactionToPromise(transaction)

        if(!entry) return null

        if(Date.now() >= entry.expiresAt){
            await deleteCacheEntry(database, key)
            return null
        }
        return entry
    }finally{
        database.close()
    }
}

export async function setMangaTranslationCache({
    imageHash,sourceLanguage,targetLanguage, cacheVersion, imageWidth, imageHeight, translatedCrops, restorationDataUrl
}){
    const database = await openCacheDatabase()

    try{
        const key = buildCacheKey({imageHash, sourceLanguage, targetLanguage, cacheVersion})
        const createdAt = Date.now()
        const entry = {
            key, 
            cacheVersion, 
            imageHash, 
            sourceLanguage, 
            targetLanguage, 
            imageWidth, 
            imageHeight, 
            translatedCrops, 
            restorationDataUrl,
            createdAt,
            expiresAt: createdAt + CACHE_TTL_MS
        }
        const transaction = database.transaction(STORE_NAME, "readwrite")

        transaction.objectStore(STORE_NAME).put(entry)

        await transactionToPromise(transaction)
        await cleanupCache(database)

        return {
            key,
            createdAt: entry.createdAt,
            expiresAt: entry.expiresAt
        }
    }finally{
        database.close()
    }
}

export async function clearMangaTranslationCache(){
    const database = await openCacheDatabase()

    try{
        const transaction = database.transaction(STORE_NAME, "readwrite")
        transaction.objectStore(STORE_NAME).clear()

        await transactionToPromise(transaction)
    }finally{
        database.close()
    }
}