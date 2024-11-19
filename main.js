// ==UserScript==
// @name        StaticResCache
// @namespace   Violentmonkey Scripts
// @grant       none
// @version     1.0
// @author      -
// @description 2024/11/19 09:27:56
// ==/UserScript==
// ==UserScript==
// @name         Static Resource Cache
// @namespace    https://jieyibu.net/
// @version      1.1
// @description  Cache static resources and intercept requests
// @author       Halo Master
// @match        *://*/*
// @grant        GM_xmlhttpRequest
// @grant        GM.setValue
// @grant        GM.getValue
// @connect      *
// ==/UserScript==

(function() {
    'use strict';

    const STATIC_EXTENSIONS = [
        '.js', '.css', '.png', '.jpg', '.jpeg',
        '.gif', '.svg', '.woff', '.woff2', '.ttf'
    ];

    const DB_NAME = 'StaticResourceCache';
    const STORE_NAME = 'resources';
    const CACHE_MAX_AGE = 24 * 60 * 60 * 1000; // 24小时
    let db;

    // 初始化 IndexedDB
    function initDB() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, 1);

            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                db = request.result;
                resolve(db);
            };

            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains(STORE_NAME)) {
                    const store = db.createObjectStore(STORE_NAME, { keyPath: 'url' });
                    store.createIndex('timestamp', 'timestamp', { unique: false });
                }
            };
        });
    }

    // 从 IndexedDB 获取缓存
    async function getCached(url) {
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(STORE_NAME, 'readonly');
            const store = transaction.objectStore(STORE_NAME);
            const request = store.get(url);

            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve(request.result);
        });
    }

    // 保存到 IndexedDB
    async function saveToCache(url, data, etag = null) {
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(STORE_NAME, 'readwrite');
            const store = transaction.objectStore(STORE_NAME);
            const request = store.put({
                url,
                data,
                etag,
                timestamp: Date.now()
            });

            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve();
        });
    }

    // 检查缓存是否需要更新
    async function shouldUpdate(cached) {
        const age = Date.now() - cached.timestamp;
        return age > CACHE_MAX_AGE;
    }

    // 后台更新缓存
    async function updateCacheInBackground(url, cached) {
        try {
            const headers = new Headers();
            if (cached.etag) {
                headers.append('If-None-Match', cached.etag);
            }

            const response = await fetch(url, { headers });

            if (response.status === 304) {
                // 资源未变化，仅更新时间戳
                await saveToCache(url, cached.data, cached.etag);
                console.log('缓存资源未变化:', url);
            } else if (response.ok) {
                // 资源已更新，保存新版本
                const { buffer, text } = await readResponseData(response);
                const etag = response.headers.get('ETag');
                await saveToCache(url, { buffer, text }, etag);
                console.log('缓存资源已更新:', url);
            }
        } catch (error) {
            console.error('后台更新缓存失败:', url, error);
        }
    }

    function isStaticResource(url) {
        try {
            if (!url || typeof url !== 'string') return false;
            return STATIC_EXTENSIONS.some(ext => url.toLowerCase().endsWith(ext));
        } catch (error) {
            console.error('检查资源类型时出错:', error);
            return false;
        }
    }

    function getUrlString(resource) {
        try {
            if (typeof resource === 'string') return resource;
            if (resource instanceof URL) return resource.href;
            if (resource instanceof Request) return resource.url;
            return null;
        } catch (error) {
            console.error('获取 URL 时出错:', error);
            return null;
        }
    }

    async function readResponseData(response) {
        const buffer = await response.arrayBuffer();
        const text = new TextDecoder().decode(buffer);
        return { buffer, text };
    }

    function interceptXHR() {
        const XHR = unsafeWindow.XMLHttpRequest;
        unsafeWindow.XMLHttpRequest = function() {
            const xhr = new XHR();
            const originalOpen = xhr.open;
            const originalSend = xhr.send;

            xhr.open = function(method, url, ...args) {
                this._url = url;
                this._method = method;
                return originalOpen.apply(this, [method, url, ...args]);
            };

            xhr.send = async function(...args) {
                if (this._method?.toUpperCase() === 'GET' && isStaticResource(this._url)) {
                    try {
                        const cached = await getCached(this._url);
                        if (cached) {
                            console.log('从磁盘缓存返回:', this._url);

                            Object.defineProperty(this, 'readyState', {value: 4});
                            Object.defineProperty(this, 'status', {value: 200});
                            Object.defineProperty(this, 'response', {value: cached.data.buffer});
                            Object.defineProperty(this, 'responseText', {value: cached.data.text});

                            setTimeout(() => {
                                this.dispatchEvent(new Event('readystatechange'));
                                this.dispatchEvent(new Event('load'));
                            }, 0);

                            // 检查是否需要更新缓存
                            if (await shouldUpdate(cached)) {
                                console.log('后台更新缓存:', this._url);
                                updateCacheInBackground(this._url, cached);
                            }

                            return;
                        }
                    } catch (error) {
                        console.error('XHR 缓存读取出错:', error);
                    }

                    this.addEventListener('load', async () => {
                        if (this.status === 200) {
                            try {
                                console.log('缓存资源到磁盘:', this._url);
                                const etag = this.getResponseHeader('ETag');
                                await saveToCache(this._url, {
                                    buffer: this.response,
                                    text: this.responseText
                                }, etag);
                            } catch (error) {
                                console.error('保存缓存失败:', error);
                            }
                        }
                    });
                }
                return originalSend.apply(this, args);
            };

            return xhr;
        };
    }

    function interceptFetch() {
        const originalFetch = unsafeWindow.fetch;
        unsafeWindow.fetch = async function(resource, init) {
            try {
                const url = getUrlString(resource);
                if (!url) return originalFetch.apply(this, arguments);

                if ((!init || init.method === undefined || init.method === 'GET') && isStaticResource(url)) {
                    const cached = await getCached(url);
                    if (cached) {
                        console.log('从磁盘缓存返回:', url);

                        // 检查是否需要更新缓存
                        if (await shouldUpdate(cached)) {
                            console.log('后台更新缓存:', url);
                            updateCacheInBackground(url, cached);
                        }

                        return new Response(cached.data.buffer.slice(0), {
                            status: 200,
                            headers: new Headers({
                                'Content-Type': url.endsWith('.js') ? 'application/javascript' :
                                              url.endsWith('.css') ? 'text/css' : 'application/octet-stream'
                            })
                        });
                    }

                    const response = await originalFetch.apply(this, arguments);
                    if (response.ok) {
                        const clone = response.clone();
                        const { buffer, text } = await readResponseData(clone);
                        const etag = response.headers.get('ETag');
                        console.log('缓存资源到磁盘:', url);
                        await saveToCache(url, { buffer, text }, etag);
                    }
                    return response;
                }
            } catch (error) {
                console.error('Fetch 拦截出错:', error);
            }

            return originalFetch.apply(this, arguments);
        };
    }

    async function cacheResource(url) {
        try {
            if (!url || !isStaticResource(url)) return;

            const cached = await getCached(url);
            if (cached) {
                // 检查是否需要更新缓存
                if (await shouldUpdate(cached)) {
                    console.log('后台更新缓存:', url);
                    updateCacheInBackground(url, cached);
                }
                return;
            }

            const response = await fetch(url);
            if (response.ok) {
                const { buffer, text } = await readResponseData(response);
                const etag = response.headers.get('ETag');
                console.log('预缓存资源到磁盘:', url);
                await saveToCache(url, { buffer, text }, etag);
            }
        } catch (error) {
            console.error('缓存资源失败:', url, error);
        }
    }
  
    function cacheCurrentPageResources() {
        try {
            const resources = [
                ...Array.from(document.getElementsByTagName('script')),
                ...Array.from(document.getElementsByTagName('link')),
                ...Array.from(document.getElementsByTagName('img'))
            ];

            resources.forEach(resource => {
                const url = resource.src || resource.href;
                if (url) cacheResource(url);
            });
        } catch (error) {
            console.error('预缓存过程出错:', error);
        }
    }

    function addDebugPanel() {
        const panel = document.createElement('div');
        panel.style.cssText = `
            position: fixed;
            bottom: 10px;
            right: 10px;
            background: rgba(0, 0, 0, 0.8);
            color: white;
            padding: 10px;
            border-radius: 5px;
            font-size: 12px;
            z-index: 9999;
            max-height: 200px;
            overflow-y: auto;
        `;

        const clearButton = document.createElement('button');
        clearButton.textContent = '清除缓存';
        clearButton.onclick = async () => {
            try {
                const transaction = db.transaction(STORE_NAME, 'readwrite');
                const store = transaction.objectStore(STORE_NAME);
                await store.clear();
                updateCacheInfo();
                console.log('磁盘缓存已清除');
            } catch (error) {
                console.error('清除缓存失败:', error);
            }
        };

        panel.appendChild(clearButton);
        document.body.appendChild(panel);

        async function updateCacheInfo() {
            try {
                const transaction = db.transaction(STORE_NAME, 'readonly');
                const store = transaction.objectStore(STORE_NAME);
                const count = await new Promise((resolve, reject) => {
                    const request = store.count();
                    request.onsuccess = () => resolve(request.result);
                    request.onerror = () => reject(request.error);
                });

                panel.innerHTML = `
                    <div>缓存状态:</div>
                    <div>缓存数量: ${count}</div>
                    ${clearButton.outerHTML}
                `;
            } catch (error) {
                console.error('更新缓存信息失败:', error);
            }
        }

        setInterval(updateCacheInfo, 1000);
    }

    async function init() {
        try {
            await initDB();
            interceptXHR();
            interceptFetch();

            if (document.readyState === 'loading') {
                document.addEventListener('DOMContentLoaded', () => {
                    cacheCurrentPageResources();
                    addDebugPanel();
                });
            } else {
                cacheCurrentPageResources();
                addDebugPanel();
            }
        } catch (error) {
            console.error('初始化过程出错:', error);
        }
    }

    init();
})();
