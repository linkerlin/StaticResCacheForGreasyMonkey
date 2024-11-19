// ==UserScript==
// @name        StaticResCache
// @namespace   Violentmonkey Scripts
// @version     1.0
// @author      -
// @description 静态资源缓存
// @match       *://*/*
// @grant       GM_xmlhttpRequest
// @grant       GM.xmlHttpRequest
// @connect     *
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

            request.onerror = () => {
                console.warn(`🔍 缓存读取失败: ${url}`, request.error);
                reject(request.error);
            };
            request.onsuccess = () => {
                if (request.result) {
                    const age = (Date.now() - request.result.timestamp) / 1000;
                    console.log(`✅ 缓存命中: ${url}\n   └── 缓存时间: ${age.toFixed(2)}秒前\n   └── 数据大小: ${(request.result.data.buffer.byteLength / 1024).toFixed(2)}KB`);
                }
                resolve(request.result);
            };
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

            const size = (data.buffer.byteLength / 1024).toFixed(2);
            console.log(`💾 正在缓存: ${url}\n   └── 数据大小: ${size}KB${etag ? '\n   └── ETag: ' + etag : ''}`);

            request.onerror = () => {
                console.error(`❌ 缓存保存失败: ${url}`, request.error);
                reject(request.error);
            };
            request.onsuccess = () => {
                console.log(`✅ 缓存保存成功: ${url}`);
                resolve();
            };
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
            console.log(`🔄 开始后台更新缓存: ${url}`);
            const headers = {};
            if (cached.etag) {
                console.log(`   └── 使用 ETag: ${cached.etag}`);
                headers['If-None-Match'] = cached.etag;
            }

            const response = await gmFetch(url, { headers });

            if (response.status === 304) {
                await saveToCache(url, cached.data, cached.etag);
                console.log(`📌 资源未变化，更新时间戳: ${url}`);
            } else if (response.ok) {
                const buffer = await response.arrayBuffer();
                const text = new TextDecoder().decode(buffer);
                const etag = response.headers.get('ETag');
                await saveToCache(url, { buffer, text }, etag);
                console.log(`📥 资源已更新: ${url}`);
            }
        } catch (error) {
            console.error(`❌ 后台更新失败: ${url}`, error);
        }
    }

    function isStaticResource(url) {
        try {
            if (!url || typeof url !== 'string') return false;
            const staticExtensions = [
                '.js', '.css', '.png', '.jpg', '.jpeg',
                '.gif', '.svg', '.woff', '.woff2', '.ttf'
            ];
            const urlLower = url.toLowerCase();
            return staticExtensions.some(ext => urlLower.endsWith(ext));
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

    // 添加 MutationObserver 来监听 DOM 变化
    function observeDOMChanges() {
        const observer = new MutationObserver((mutations) => {
            mutations.forEach((mutation) => {
                mutation.addedNodes.forEach((node) => {
                    if (node.nodeType === 1) { // 元素节点
                        // 检查新添加的元素中的资源
                        const resources = [
                            ...Array.from(node.getElementsByTagName('script') || []),
                            ...Array.from(node.getElementsByTagName('link') || []),
                            ...Array.from(node.getElementsByTagName('img') || [])
                        ];
                        
                        // 如果节点本身是资源节点，也加入检查
                        if (['SCRIPT', 'LINK', 'IMG'].includes(node.tagName)) {
                            resources.push(node);
                        }

                        resources.forEach(resource => {
                            const url = resource.src || resource.href;
                            if (url) cacheResource(url);
                        });
                    }
                });
            });
        });

        observer.observe(document.documentElement, {
            childList: true,
            subtree: true
        });

        console.log('🔍 DOM 变化监听器已启动');
    }

    // 修改 interceptXHR 函数，增加更多日志
    function interceptXHR() {
        const XHR = unsafeWindow.XMLHttpRequest;
        unsafeWindow.XMLHttpRequest = function() {
            const xhr = new XHR();
            const originalOpen = xhr.open;
            const originalSend = xhr.send;

            xhr.open = function(method, url, ...args) {
                this._url = url;
                this._method = method;
                console.log(`📡 拦截到 XHR 请求: ${method} ${url}`);
                return originalOpen.apply(this, [method, url, ...args]);
            };

            xhr.send = async function(...args) {
                if (this._method?.toUpperCase() === 'GET' && isStaticResource(this._url)) {
                    try {
                        const cached = await getCached(this._url);
                        if (cached) {
                            console.log(`🎯 XHR 请求使用缓存: ${this._url}`);

                            Object.defineProperty(this, 'readyState', {value: 4});
                            Object.defineProperty(this, 'status', {value: 200});
                            Object.defineProperty(this, 'response', {value: cached.data.buffer});
                            Object.defineProperty(this, 'responseText', {value: cached.data.text});

                            setTimeout(() => {
                                this.dispatchEvent(new Event('readystatechange'));
                                this.dispatchEvent(new Event('load'));
                            }, 0);

                            if (await shouldUpdate(cached)) {
                                updateCacheInBackground(this._url, cached);
                            }
                            return;
                        }
                    } catch (error) {
                        console.error('XHR 缓存读取出错:', error);
                    }
                }
                return originalSend.apply(this, args);
            };

            return xhr;
        };
        console.log('🔄 XHR 拦截器已启动');
    }

    // 修改 interceptFetch 函数
    function interceptFetch() {
        const originalFetch = unsafeWindow.fetch;
        unsafeWindow.fetch = async function(resource, init) {
            try {
                const url = getUrlString(resource);
                if (!url) return originalFetch.apply(this, arguments);

                console.log(`📡 拦截到 Fetch 请求: ${url}`);

                if ((!init || init.method === undefined || init.method === 'GET') && isStaticResource(url)) {
                    const cached = await getCached(url);
                    if (cached) {
                        console.log(`🎯 Fetch 请求使用缓存: ${url}`);

                        if (await shouldUpdate(cached)) {
                            updateCacheInBackground(url, cached);
                        }

                        return new Response(cached.data.buffer.slice(0), {
                            status: 200,
                            headers: new Headers({
                                'Content-Type': url.endsWith('.js') ? 'application/javascript' :
                                              url.endsWith('.css') ? 'text/css' : 
                                              url.endsWith('.png') ? 'image/png' :
                                              url.endsWith('.jpg') || url.endsWith('.jpeg') ? 'image/jpeg' :
                                              url.endsWith('.gif') ? 'image/gif' :
                                              url.endsWith('.svg') ? 'image/svg+xml' :
                                              'application/octet-stream',
                                'X-Cache': 'HIT'
                            })
                        });
                    }

                    try {
                        // 使用 gmFetch 获取资源
                        const response = await gmFetch(url, init);
                        if (response.ok) {
                            const buffer = await response.arrayBuffer();
                            const text = new TextDecoder().decode(buffer);
                            const etag = response.headers.get('ETag');
                            await saveToCache(url, { buffer, text }, etag);
                            
                            // 返回一个新的 Response 对象
                            return new Response(buffer, {
                                status: response.status,
                                headers: response.headers
                            });
                        }
                        return response;
                    } catch (fetchError) {
                        console.error(`使用 gmFetch 失败，尝试原始 fetch: ${url}`, fetchError);
                        return originalFetch.apply(this, arguments);
                    }
                }

                // 非静态资源使用原始 fetch
                return originalFetch.apply(this, arguments);
            } catch (error) {
                console.error('Fetch 拦截出错:', error);
                // 发生错误时回退到原始 fetch
                return originalFetch.apply(this, arguments);
            }
        };
        console.log('🔄 Fetch 拦截器已启动');
    }

    // 添加 GM_xmlhttpRequest 包装函数
    function gmFetch(url, options = {}) {
        const gmRequest = typeof GM_xmlhttpRequest !== 'undefined' ? 
            GM_xmlhttpRequest : 
            GM.xmlHttpRequest;

        if (!gmRequest) {
            console.error('未找到 GM_xmlhttpRequest 或 GM.xmlHttpRequest，请检查脚本权限设置');
            return Promise.reject(new Error('GM_xmlhttpRequest not available'));
        }

        return new Promise((resolve, reject) => {
            gmRequest({
                method: options.method || 'GET',
                url: url,
                headers: options.headers || {},
                responseType: 'arraybuffer',
                onload: function(response) {
                    resolve({
                        ok: response.status >= 200 && response.status < 300,
                        status: response.status,
                        headers: new Headers(response.responseHeaders.split('\r\n').reduce((headers, line) => {
                            const [key, value] = line.split(': ');
                            if (key && value) headers[key] = value;
                            return headers;
                        }, {})),
                        arrayBuffer: () => Promise.resolve(response.response)
                    });
                },
                onerror: function(error) {
                    console.error(`请求失败: ${url}`, error);
                    reject(error);
                }
            });
        });
    }

    // 修改 cacheResource 函数
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

            console.log(`🔄 开始获取资源: ${url}`);
            const response = await gmFetch(url);
            if (response.ok) {
                const buffer = await response.arrayBuffer();
                const text = new TextDecoder().decode(buffer);
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
            max-height: 300px;
            overflow-y: auto;
            min-width: 200px;
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

                // 计算总缓存大小
                let totalSize = 0;
                store.openCursor().onsuccess = function(event) {
                    const cursor = event.target.result;
                    if (cursor) {
                        totalSize += cursor.value.data.buffer.byteLength;
                        cursor.continue();
                    } else {
                        const sizeMB = (totalSize / (1024 * 1024)).toFixed(2);
                        panel.innerHTML = `
                            <div style="margin-bottom: 8px;">📊 缓存状态</div>
                            <div>📦 缓存数量: ${count}</div>
                            <div>💾 总大小: ${sizeMB} MB</div>
                            <div style="margin-top: 8px;">
                                <button onclick="location.reload()" style="margin-right: 5px;">🔄 刷新</button>
                                ${clearButton.outerHTML}
                            </div>
                        `;
                    }
                };
            } catch (error) {
                console.error('更新缓存信息失败:', error);
            }
        }

        setInterval(updateCacheInfo, 1000);
    }

    // 修改 init 函数
    async function init() {
        try {
            await initDB();
            interceptXHR();
            interceptFetch();
            
            if (document.readyState === 'loading') {
                document.addEventListener('DOMContentLoaded', () => {
                    cacheCurrentPageResources();
                    addDebugPanel();
                    observeDOMChanges(); // 添加 DOM 监听
                });
            } else {
                cacheCurrentPageResources();
                addDebugPanel();
                observeDOMChanges(); // 添加 DOM 监听
            }
            
            console.log('🚀 静态资源缓存系统初始化完成');
        } catch (error) {
            console.error('初始化过程出错:', error);
        }
    }

    init();
})();
