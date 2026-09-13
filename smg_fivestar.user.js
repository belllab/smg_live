// ==UserScript==
// @name             收看SMGTV电视节目
// @namespace        http://tampermonkey.net/
// @version          0.21
// @description      收看SMGTV，并解除页面部分限制
// @author           https://github.com/Popukok
// @match            *://*.kankanews.com/huikan*
// @icon             https://live.kankanews.com/favicon.ico
// @updateURL        https://raw.githubusercontent.com/Popukok/smg_live/refs/heads/main/smg_fivestar.user.js
// @downloadURL      https://raw.githubusercontent.com/Popukok/smg_live/refs/heads/main/smg_fivestar.user.js
// @run-at           document-start
// @grant            GM_xmlhttpRequest
// @grant            unsafeWindow
// @connect          kapi.kankanews.com
// ==/UserScript==
(function() {
    'use strict';
    const UW = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
    const LS = (() => { try { return UW.localStorage || localStorage; } catch (e) { return localStorage; } })();
    const STYLE_ID = 'smgtv-unlock-style';
    const VIDEO_READY_CLASS = 'smgtv-video-ready';
    const FULLSCREEN_FALLBACK_CLASS = 'smgtv-fallback-fullscreen';
    const FULLSCREEN_TARGET_CLASS = 'smgtv-fallback-fullscreen-target';
    const FULLSCREEN_BUTTON_SELECTOR = '.xgplayer-fullscreen';
    const VIDEO_READY_EVENTS = ['loadeddata', 'canplay', 'playing', 'timeupdate', 'progress'];
    const VIDEO_RESET_EVENTS = ['loadstart', 'waiting', 'stalled', 'emptied'];
    const watchedVideos = new WeakSet();
    const streamAddressCache = Object.create(null);
    const channelShiftBaseCache = Object.create(null);
    const channelLiveBaseCache = Object.create(null);
    // 同一条播放地址上可能挂着两套期限：地址参数（如 volcTime / expire）与 token 里 JWT 的 exp。
    // 视频服务器按“最早到期”的那个拒绝请求，缓存也必须按最早的那个淘汰，
    // 否则会一直认为旧地址可用，拿已被 403 的地址反复播放。
    const STREAM_RENEW_MARGIN_MS = 120000;        // 到期前多久开始换源
    const STREAM_RENEW_COOLDOWN_MS = 60000;       // 两次主动换源之间的最小间隔
    const BASE_SAFETY_MS = 5000;                  // 剩余寿命低于此值就不再算“可用”
    const STREAM_NO_EXP_TTL_MS = 20 * 60 * 1000;  // 解析不出任何期限时的保守缓存寿命
    const STREAM_ADDRESS_TTL_MS = 30 * 60 * 1000; // 接口回填地址的缓存寿命
    // 停滞阈值必须明显大于 hls.js 自身的分片重试窗口（约 20s），
    // 否则弱网下正常缓冲会被当成断流，把本可自愈的播放器拆掉
    const STALL_TIMEOUT_MS = 30000;               // 画面停滞多久判定为断流
    // 重建后新地址同样不可播时，currentTime 会永远停在 0，所有“画面不再前进”
    // 的判据都失效，需要单独给一个更长的窗口兜这种情况
    const STUCK_START_TIMEOUT_MS = 60000;         // 一直没起播多久判定为失败
    const RECOVER_COOLDOWN_MS = 15000;            // 两次恢复尝试之间的最小间隔
    const RECOVER_MAX_COOLDOWN_MS = 5 * 60 * 1000; // 反复恢复无效时的退避上限
    // 回看进度记录只在「记下之后马上重建」时才有意义，超过这个窗口就作废，
    // 避免之后一次无关的重建拿陈旧记录乱跳进度
    const RESUME_POSITION_TTL_MS = 90000;
    // 自动换源拿到的是“往期节目的回看源”，非 10 频道当直播源注入会播出错内容，
    // 因此只对确知可用的频道开启
    const AUTO_ACQUIRE_CHANNELS = ['10'];
    const SMG_API_SECRET = '28c8edde3d61a0411511d3b1866f0636';
    const SMG_API_VERSION = '2.42.23';
    const SMG_PUBKEY = '-----BEGIN PUBLIC KEY-----\n' +
          'MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDP5hzPUW5RFeE2xBT1ERB3hHZI\n' +
          'Votn/qatWhgc1eZof09qKjElFN6Nma461ZAwGpX4aezKP8Adh4WJj4u2O54xCXDt\n' +
          'wzKRqZO2oNZkuNmF2Va8kLgiEQAAcxYc8JgTN+uQQNpsep4n/o1sArTJooZIF17E\n' +
          'tSqSgXDcJ7yDj5rc7wIDAQAB\n' +
          '-----END PUBLIC KEY-----';
    function parseJwtValueExp(token) {
        try {
            if (!token || token.split('.').length !== 3) return null;
            const payload = token.split('.')[1];
            if (!payload) return null;
            const b64 = payload.replace(/-/g, '+').replace(/_/g, '/');
            const padded = b64 + '='.repeat((4 - b64.length % 4) % 4);
            const json = JSON.parse(atob(padded));
            // exp 必须是个像样的时间戳。0 或负数只会出现在畸形/占位 token 里，
            // 放行的话会一路传到缓存，被当成"解析出了真实期限"参与择优
            if (typeof json.exp !== 'number' || !(json.exp > 0)) return null;
            return json.exp * 1000;
        } catch (e) {
            return null;
        }
    }
    function parseJwtExp(url) {
        try {
            return parseJwtValueExp(new URL(url).searchParams.get('token'));
        } catch (e) {
            return null;
        }
    }
    function toEpochMs(value) {
        const n = Number(value);
        if (!isFinite(n) || n <= 0) return null;
        if (n >= 1e12) return n;
        if (n >= 1e8) return n * 1000;
        return null;
    }
    // 只收明确表示“到期时间”的参数名。绝不能收 authtime/validtime 这类可能表示
    // “签发时间”的名字——那会让一条刚拿到手的地址立刻被判成已过期。
    const STREAM_EXP_KEYS = ['volctime', 'volc_time', 'expire', 'expires', 'expiretime',
                             'expire_time', 'expiredtime', 'wstime', 'ws_time', 'exper'];
    // 地址参数上的期限（火山源的 volcTime 等），这类期限通常比 JWT 的 exp 早得多
    function parseUrlTimeExpiry(url) {
        const now = Date.now();
        let min = null;
        try {
            new URL(url).searchParams.forEach((value, key) => {
                const k = key.toLowerCase();
                if (STREAM_EXP_KEYS.indexOf(k) === -1 && !/(expire|expiry|deadline)/.test(k)) return;
                const t = toEpochMs(value);
                if (t == null || t < now - 86400000 || t > now + 60 * 86400000) return;
                if (min == null || t < min) min = t;
            });
        } catch (e) {}
        return min;
    }
    // token 不一定挂在 token 参数上，任何 JWT 形状的参数都算
    function parseUrlJwtExp(url) {
        const now = Date.now();
        let min = null;
        try {
            new URL(url).searchParams.forEach(value => {
                if (value.split('.').length !== 3) return;
                const t = parseJwtValueExp(value);
                // 必须过滤：任意一个无关的三段式参数只要解出更早的 exp，
                // 就能把整条地址的有效期拉到过去，导致可用地址被误判为已过期
                if (t == null || t < now - 86400000 || t > now + 60 * 86400000) return;
                if (min == null || t < min) min = t;
            });
        } catch (e) {}
        return min;
    }
    // 一条地址上可能同时带多个期限，取最早的那个作为真正的有效期
    function parseStreamExpiry(url) {
        if (!url || typeof url !== 'string') return null;
        const candidates = [parseJwtExp(url), parseUrlJwtExp(url), parseUrlTimeExpiry(url)]
            .filter(t => t != null);
        if (!candidates.length) return null;
        return Math.min.apply(null, candidates);
    }
    function smgMd5(str) {
        function rl(n, c) { return (n << c) | (n >>> (32 - c)); }
        function add(x, y) {
            var l = (x & 0xffff) + (y & 0xffff);
            var m = (x >> 16) + (y >> 16) + (l >> 16);
            return (m << 16) | (l & 0xffff);
        }
        function cmn(q, a, b, x, s, t) {
            a = add(add(a, q), add(x, t));
            return add(rl(a, s), b);
        }
        function ff(a, b, c, d, x, s, t) { return cmn((b & c) | ((~b) & d), a, b, x, s, t); }
        function gg(a, b, c, d, x, s, t) { return cmn((b & d) | (c & (~d)), a, b, x, s, t); }
        function hh(a, b, c, d, x, s, t) { return cmn(b ^ c ^ d, a, b, x, s, t); }
        function ii(a, b, c, d, x, s, t) { return cmn(c ^ (b | (~d)), a, b, x, s, t); }
        function binl(s) {
            var b = [];
            var m = (1 << 8) - 1;
            for (var i = 0; i < s.length * 8; i += 8) b[i >> 5] |= (s.charCodeAt(i / 8) & m) << (i % 32);
            return b;
        }
        function binl2hex(b) {
            var h = "0123456789abcdef";
            var s = "";
            for (var i = 0; i < b.length * 4; i++) {
                s += h.charAt((b[i >> 2] >> ((i % 4) * 8 + 4)) & 0xf) + h.charAt((b[i >> 2] >> ((i % 4) * 8)) & 0xf);
            }
            return s;
        }
        str = unescape(encodeURIComponent(str));
        var x = binl(str);
        x[str.length >> 2] |= 0x80 << ((str.length % 4) << 3);
        x[(((str.length + 8) >> 6) << 4) + 14] = str.length * 8;
        var a = 1732584193, b = -271733879, c = -1732584194, d = 271733878;
        for (var i = 0; i < x.length; i += 16) {
            var oa = a, ob = b, oc = c, od = d;
            a = ff(a, b, c, d, x[i], 7, -680876936); d = ff(d, a, b, c, x[i + 1], 12, -389564586);
            c = ff(c, d, a, b, x[i + 2], 17, 606105819); b = ff(b, c, d, a, x[i + 3], 22, -1044525330);
            a = ff(a, b, c, d, x[i + 4], 7, -176418897); d = ff(d, a, b, c, x[i + 5], 12, 1200080426);
            c = ff(c, d, a, b, x[i + 6], 17, -1473231341); b = ff(b, c, d, a, x[i + 7], 22, -45705983);
            a = ff(a, b, c, d, x[i + 8], 7, 1770035416); d = ff(d, a, b, c, x[i + 9], 12, -1958414417);
            c = ff(c, d, a, b, x[i + 10], 17, -42063); b = ff(b, c, d, a, x[i + 11], 22, -1990404162);
            a = ff(a, b, c, d, x[i + 12], 7, 1804603682); d = ff(d, a, b, c, x[i + 13], 12, -40341101);
            c = ff(c, d, a, b, x[i + 14], 17, -1502002290); b = ff(b, c, d, a, x[i + 15], 22, 1236535329);
            a = gg(a, b, c, d, x[i + 1], 5, -165796510); d = gg(d, a, b, c, x[i + 6], 9, -1069501632);
            c = gg(c, d, a, b, x[i + 11], 14, 643717713); b = gg(b, c, d, a, x[i], 20, -373897302);
            a = gg(a, b, c, d, x[i + 5], 5, -701558691); d = gg(d, a, b, c, x[i + 10], 9, 38016083);
            c = gg(c, d, a, b, x[i + 15], 14, -660478335); b = gg(b, c, d, a, x[i + 4], 20, -405537848);
            a = gg(a, b, c, d, x[i + 9], 5, 568446438); d = gg(d, a, b, c, x[i + 14], 9, -1019803690);
            c = gg(c, d, a, b, x[i + 3], 14, -187363961); b = gg(b, c, d, a, x[i + 8], 20, 1163531501);
            a = gg(a, b, c, d, x[i + 13], 5, -1444681467); d = gg(d, a, b, c, x[i + 2], 9, -51403784);
            c = gg(c, d, a, b, x[i + 7], 14, 1735328473); b = gg(b, c, d, a, x[i + 12], 20, -1926607734);
            a = hh(a, b, c, d, x[i + 5], 4, -378558); d = hh(d, a, b, c, x[i + 8], 11, -2022574463);
            c = hh(c, d, a, b, x[i + 11], 16, 1839030562); b = hh(b, c, d, a, x[i + 14], 23, -35309556);
            a = hh(a, b, c, d, x[i + 1], 4, -1530992060); d = hh(d, a, b, c, x[i + 4], 11, 1272893353);
            c = hh(c, d, a, b, x[i + 7], 16, -155497632); b = hh(b, c, d, a, x[i + 10], 23, -1094730640);
            a = hh(a, b, c, d, x[i + 13], 4, 681279174); d = hh(d, a, b, c, x[i], 11, -358537222);
            c = hh(c, d, a, b, x[i + 3], 16, -722521979); b = hh(b, c, d, a, x[i + 6], 23, 76029189);
            a = hh(a, b, c, d, x[i + 9], 4, -640364487); d = hh(d, a, b, c, x[i + 12], 11, -421815835);
            c = hh(c, d, a, b, x[i + 15], 16, 530742520); b = hh(b, c, d, a, x[i + 2], 23, -995338651);
            a = ii(a, b, c, d, x[i], 6, -198630844); d = ii(d, a, b, c, x[i + 7], 10, 1126891415);
            c = ii(c, d, a, b, x[i + 14], 15, -1416354905); b = ii(b, c, d, a, x[i + 5], 21, -57434055);
            a = ii(a, b, c, d, x[i + 12], 6, 1700485571); d = ii(d, a, b, c, x[i + 3], 10, -1894986606);
            c = ii(c, d, a, b, x[i + 10], 15, -1051523); b = ii(b, c, d, a, x[i + 1], 21, -2054922799);
            a = ii(a, b, c, d, x[i + 8], 6, 1873313359); d = ii(d, a, b, c, x[i + 15], 10, -30611744);
            c = ii(c, d, a, b, x[i + 6], 15, -1560198380); b = ii(b, c, d, a, x[i + 13], 21, 1309151649);
            a = ii(a, b, c, d, x[i + 4], 6, -145523070); d = ii(d, a, b, c, x[i + 11], 10, -1120210379);
            c = ii(c, d, a, b, x[i + 2], 15, 718787259); b = ii(b, c, d, a, x[i + 9], 21, -343485551);
            a = add(a, oa); b = add(b, ob); c = add(c, oc); d = add(d, od);
        }
        return binl2hex([a, b, c, d]);
    }
    function smgSignParams(params) {
        const n = {
            platform: 'pc',
            version: SMG_API_VERSION,
            nonce: Math.random().toString(36).slice(-8),
            timestamp: Math.floor(Date.now() / 1000),
            'Api-Version': 'v1'
        };
        const merged = {};
        Object.keys(params).forEach(k => { merged[k] = params[k]; });
        Object.keys(n).forEach(k => { merged[k] = n[k]; });
        let s = '';
        Object.keys(merged).sort().forEach(k => {
            if (merged[k] != null) s += k + '=' + merged[k] + '&';
        });
        merged.sign = smgMd5(smgMd5(s + SMG_API_SECRET));
        return merged;
    }
    function shortUrl(url) { return url.split('kankanews.com')[1] || ''; }
    function gmApiGet(url, headers) {
        let gmHeaders = headers;
        try {
            const ua = (UW.navigator && UW.navigator.userAgent) || navigator.userAgent;
            if (ua) gmHeaders = Object.assign({}, headers, { 'User-Agent': ua });
        } catch (e) {}
        return new Promise((resolve) => {
            try {
                GM_xmlhttpRequest({
                    method: 'GET',
                    url: url,
                    headers: gmHeaders,
                    timeout: 15000,
                    onload: function(response) {
                        try {
                            if (response.status !== 200) {
                                console.warn('[SMGTV] GM接口异常 status=', response.status, shortUrl(url));
                            }
                            resolve(JSON.parse(response.responseText));
                        } catch (e) {
                            console.warn('[SMGTV] GM响应解析失败 status=', response.status, shortUrl(url));
                            resolve(null);
                        }
                    },
                    onerror: function() { console.warn('[SMGTV] GM请求失败', shortUrl(url)); resolve(null); },
                    ontimeout: function() { console.warn('[SMGTV] GM请求超时', shortUrl(url)); resolve(null); }
                });
            } catch (e) {
                console.warn('[SMGTV] GM调用异常', e);
                resolve(null);
            }
        });
    }
    function smgApiGet(path, params) {
        const signed = smgSignParams(params || {});
        const q = Object.keys(params || {}).map(k => encodeURIComponent(k) + '=' + encodeURIComponent(params[k])).join('&');
        const headers = { Accept: 'application/json, text/plain, */*' };
        Object.keys(signed).forEach(hk => { headers[hk] = signed[hk]; });
        headers['M-Uuid'] = LS.getItem('uuid') || '';
        const url = 'https://kapi.kankanews.com' + path + (q ? '?' + q : '');
        let pageFetch;
        try {
            // 页面 fetch 没有超时，一旦挂住会让 __smgAcquiring 永远为真、换源彻底停摆，
            // 这里限时后退回 GM 请求（GM 自带 15s 超时）
            const opts = { headers: headers };
            let timer = null;
            if (typeof UW.AbortController === 'function') {
                const controller = new UW.AbortController();
                opts.signal = controller.signal;
                timer = setTimeout(() => {
                    try { controller.abort(); } catch (e) {}
                }, 12000);
            }
            pageFetch = Promise.resolve(UW.fetch(url, opts)).finally(() => {
                if (timer) clearTimeout(timer);
            });
        } catch (e) {
            return gmApiGet(url, headers);
        }
        return pageFetch
            .then(res => {
                if (!res || !res.ok) {
                    console.warn('[SMGTV] 接口异常 status=', res && res.status, shortUrl(url));
                }
                return res.text();
            })
            .then(txt => JSON.parse(txt))
            .catch(e => {
                console.warn('[SMGTV] 页面fetch失败, 转GM兜底:', shortUrl(url), e && e.message);
                return gmApiGet(url, headers);
            });
    }
    function hexToBase64(hexStr) {
        try {
            const bytes = hexStr.replace(/\s+/g, '').match(/[\da-fA-F]{2}/g) || [];
            if (!bytes.length) return '';
            return btoa(bytes.map(b => String.fromCharCode(parseInt(b, 16))).join(''));
        } catch (e) {
            return '';
        }
    }
    function decryptRsaChunks(encryptedBase64, onReady) {
        let done = false;
        const finish = result => {
            if (done) return;
            done = true;
            onReady(result);
        };
        const tryDecrypt = () => {
            if (typeof UW.JSEncrypt === 'undefined') return false;
            try {
                const encrypt = new UW.JSEncrypt();
                encrypt.setPublicKey(SMG_PUBKEY);
                let hexStr;
                try {
                    const binary = atob(encryptedBase64);
                    hexStr = Array.from(binary, ch => ('0' + ch.charCodeAt(0).toString(16)).slice(-2)).join('').toUpperCase();
                } catch (e) {
                    finish('');
                    return true;
                }
                let out = '';
                for (let i = 0; i < hexStr.length;) {
                    const chunk = hexStr.slice(i, i + 256);
                    i += 256;
                    const b64 = hexToBase64(chunk);
                    if (!b64) continue;
                    const decrypted = encrypt.decrypt(b64);
                    if (decrypted) out += decrypted;
                }
                if (out) {
                    finish(out);
                    return true;
                }
            } catch (e) {}
            return false;
        };
        if (tryDecrypt()) return;
        let tries = 0;
        const timer = setInterval(() => {
            tries += 1;
            if (tryDecrypt()) {
                clearInterval(timer);
            } else if (tries > 50) {
                clearInterval(timer);
                console.warn('[SMGTV] RSA解密失败(JSEncrypt不可用或密文异常)');
                finish('');
            }
        }, 200);
    }
    let fullscreenFallbackTarget = null;
    let cssFullscreenFallbackPlayer = null;
    let lastFullscreenActionAt = 0;
    const logThrottle = Object.create(null);
    function throttleLog(key, intervalMs, fn) {
        const now = Date.now();
        if ((logThrottle[key] || 0) + intervalMs > now) {
            return;
        }
        logThrottle[key] = now;
        fn();
    }
    function rememberStreamAddresses(channelId, liveAddress, shiftAddress) {
        if (channelId == null || channelId === '') {
            return;
        }
        const key = String(channelId);
        const prev = streamAddressCache[key] || { live_address: '', shift_address: '' };
        streamAddressCache[key] = {
            live_address: liveAddress || prev.live_address || '',
            shift_address: shiftAddress || prev.shift_address || '',
            at: Date.now()
        };
    }
    function fillStreamAddresses(target, channelId) {
        if (!target) {
            return false;
        }
        const cached = streamAddressCache[String(channelId)];
        if (!cached) {
            return false;
        }
        // 不把已经放太久的地址回填给页面，否则页面会以为手里还有可播的源，
        // 重建播放器时继续拿到旧地址
        if (Date.now() - (cached.at || 0) > STREAM_ADDRESS_TTL_MS) {
            delete streamAddressCache[String(channelId)];
            return false;
        }
        const channelLiveAddress = cached.live_address || cached.shift_address;
        const channelShiftAddress = cached.shift_address || cached.live_address;
        if (channelLiveAddress && !target.live_address) {
            target.live_address = channelLiveAddress;
        }
        if (channelShiftAddress && !target.shift_address) {
            target.shift_address = channelShiftAddress;
        }
    }
    function getResultChannelId(result) {
        return result?.channel_id || result?.channel_info?.id || result?.id;
    }
    function forceOpenProgram(program) {
        if (!program) {
            return;
        }
        program.is_shield = 0;
        program.can_review = 1;
        program.is_review = 1;
    }
    function forceOpenProgramList(component) {
        if (!component) {
            return;
        }
        ['currentProgramList', 'playingProgramList', 'slitProgramList'].forEach(key => {
            const list = component[key];
            if (!Array.isArray(list)) {
                return;
            }
            list.forEach(program => {
                if (program && (program.is_shield !== 0 || program.can_review !== 1 || program.is_review !== 1)) {
                    forceOpenProgram(program);
                }
            });
        });
        const detailPrograms = component.programDetail?.program_list;
        if (Array.isArray(detailPrograms)) {
            detailPrograms.forEach(program => forceOpenProgram(program));
        }
    }
    function ensurePlayableStream(component) {
        if (!component) {
            return;
        }
        forceOpenProgram(component.programObj);
        const channelDetail = component.currChannelDetail;
        if (channelDetail) {
            rememberStreamAddresses(channelDetail.id, channelDetail.live_address, channelDetail.shift_address);
        }
        const detail = component.programDetail;
        if (!detail) {
            return;
        }
        forceOpenProgram(detail);
        if (detail.is_exist_pad && !(detail.pad_video_info && detail.pad_video_info.play_url)) {
            detail.is_exist_pad = 0;
            detail.pad_src = '';
        }
        const channelInfo = detail.channel_info || (detail.channel_info = {});
        const channelId = getResultChannelId(detail) || channelDetail?.id;
        if (channelDetail) {
            if (channelDetail.live_address) {
                channelInfo.live_address = channelDetail.live_address;
            }
            if (channelDetail.shift_address) {
                channelInfo.shift_address = channelDetail.shift_address;
            }
        }
        fillStreamAddresses(channelInfo, channelId);
    }
    function stripTimeWindow(url) {
        try {
            const u = new URL(url);
            u.searchParams.delete('start');
            u.searchParams.delete('end');
            return u.toString();
        } catch (e) {
            return url
                .replace(/&start=\d+&end=\d+(?=&|$)/g, '')
                .replace(/\?start=\d+&end=\d+(?=&|$)/g, '?')
                .replace(/\?$/, '');
        }
    }
    function isMobileSite() {
        try { return /^m\./.test(location.hostname); } catch (e) { return false; }
    }
    function getCompChannelId(component) {
        if (!component) return null;
        if (component.currChannel?.id != null) return component.currChannel.id;
        if (component.currChannelDetail?.id != null) return component.currChannelDetail.id;
        if (component.programDetail?.channel_info?.id != null) return component.programDetail.channel_info.id;
        if (component.id != null && /^\d+$/.test(String(component.id))) return component.id;
        if (component.programObj?.channel_id != null) return component.programObj.channel_id;
        return null;
    }
    function canAutoAcquire(channelId) {
        return channelId != null && AUTO_ACQUIRE_CHANNELS.indexOf(String(channelId)) !== -1;
    }
    // 缓存条目的真实有效期可能解析不出来，此时退回按写入时间估算的保守寿命，
    // 避免一条判定不出期限的地址被无限期复用
    function baseExpiryOf(entry) {
        if (!entry) return 0;
        // 必须用 != null 而不是真值判断：写成 if (entry.exp) 的话 exp 为 0
        // 会掉进兜底分支拿到「写入时间 + 20 分钟」的假寿命，
        // 反而让这条早已过期的地址变得"可用"，而 betterBase 那边又按「有 exp」优先选它
        if (entry.exp != null) return entry.exp;
        return (entry.at || 0) + STREAM_NO_EXP_TTL_MS;
    }
    // 两条候选谁更该用。不能只比 baseExpiryOf：
    // 两边都解析不出期限时会退化成纯比写入时间，而页面回填的那条总是写得更晚，
    // 于是脚本刚取到的新源永远选不上，「强制换源」就变成了空转。
    function betterBase(a, b) {
        if (!a) return b;
        if (!b) return a;
        const aHasExp = a.exp != null;
        const bHasExp = b.exp != null;
        if (aHasExp !== bHasExp) {
            return aHasExp ? a : b;                       // 解析得出真实期限的更可信
        }
        const aScript = a.src === 'script';
        const bScript = b.src === 'script';
        if (aScript !== bScript) {
            return aScript ? a : b;                       // 脚本取到的比页面回填的可信
        }
        return baseExpiryOf(a) >= baseExpiryOf(b) ? a : b;
    }
    // kind === 'shift' 时只取回看源——回看必须只认回看源，
    // 拿直播地址去拼接 start/end 会被服务端拒绝。
    // 其余情况两个缓存都看：自动取源拿到的地址只写进 shift 缓存，
    // 把直播限定成只查 live 缓存会让新取的源永远注入不进去。
    function resolveBaseEntry(channelId, kind) {
        const now = Date.now();
        if (channelId == null) return null;
        const candidates = kind === 'shift' ? [channelShiftBaseCache[channelId]]
            : [channelShiftBaseCache[channelId], channelLiveBaseCache[channelId]];
        const usable = candidates
            .filter(entry => entry && entry.url && baseExpiryOf(entry) - BASE_SAFETY_MS > now);
        if (!usable.length) return null;
        return usable.reduce(betterBase);
    }
    function installReplayUrlPatch(component) {
        const XGPlayer = component.$xgplayer;
        if (!XGPlayer || component.__smgReplayPatchInstalled) {
            return;
        }
        component.__smgReplayPatchInstalled = true;
        component.$xgplayer = new Proxy(XGPlayer, {
            construct(target, args) {
                const config = args[0] || {};
                const program = component.programObj;
                const channelId = getCompChannelId(component);
                let url = (config.url && typeof config.url === 'string') ? config.url : '';
                const hasStream = /\.m3u8/.test(url);
                const hasWindow = /\bstart=\d/.test(url);
                if (channelId != null && hasStream) {
                    const base = stripTimeWindow(url);
                    if (base) {
                        const fromShift = /[?&]start=\d+/.test(url);
                        const store = fromShift ? channelShiftBaseCache : channelLiveBaseCache;
                        const entry = { url: base, at: Date.now(), exp: parseStreamExpiry(url), src: 'page' };
                        // 页面重建播放器时可能塞回来一条已经过期的地址，
                        // 不能用它把已经取到的新源覆盖掉。
                        // 注意这里要单独判断 exp 是否为空——baseExpiryOf 对空 exp 会兜底成
                        // 「写入时间 + 20 分钟」，直接比大小会让新地址反而输给旧条目。
                        const prev = store[channelId];
                        // 这里只比较期限。还有一条判据是「脚本取到的比页面回填的可信」，
                        // 但它放在 betterBase 里按来源比较，不在这里做——
                        // 写成"保护期内拒绝页面条目"会让保护期随每次重新取源顺延，
                        // 接口持续返回坏地址时，页面那条可用地址就被永久挡在门外了。
                        const canStore = !prev ||
                              (entry.exp != null && (prev.exp == null || entry.exp >= prev.exp)) ||
                              (entry.exp == null && prev.exp == null);
                        if (canStore) {
                            store[channelId] = entry;
                            console.log(fromShift ? '[SMGTV] 已抓取回看源' : '[SMGTV] 已抓取直播源');
                        }
                    }
                }
                const isReplay = config.isLive === false;
                // 回看必须只认回看源（拿直播地址拼 start/end 会被服务端拒绝）。
                // 直播则要看两个缓存：自动取源拿到的地址只写进 shift 缓存
                // （见 fetchShiftByDonor），只查 live 缓存会让它永远看不见新取的源。
                const baseEntry = resolveBaseEntry(channelId, isReplay ? 'shift' : '');
                const baseOk = baseEntry ? baseEntry.url : '';
                // 页面自带的地址可能已经过期（地址参数上的期限比 JWT 早得多）。
                // 只要判定它已失效，就不能再原样放行，必须换成脚本重新取到的源。
                const urlExp = parseStreamExpiry(url);
                const urlStale = hasStream && urlExp != null && urlExp - BASE_SAFETY_MS <= Date.now();
                // 标记只影响紧接着的这一次构造。注意不能在这里无条件清掉：
                // 一次与目标无关的兜底重建会把标记吃掉，等在飞的取源回来时已经失去 forcing。
                // 真正的清零点在下面“确实用它换掉了页面地址”的分支里。
                const forcing = Date.now() < (component.__smgPreferFreshBaseUntil || 0);
                // forcing 只会由 forceRenewStream 置位，而它只在白名单频道真的取到源时才有效，
                // 所以这里的 forcing 项不需要再判一次白名单
                const staleTrigger = urlStale && (isReplay || canAutoAcquire(channelId));
                const preferBase = !!baseEntry &&
                      (!hasStream || staleTrigger || (forcing && baseExpiryOf(baseEntry) > (urlExp || 0)));
                if (isReplay && hasWindow) {
                    return new target(...args);
                }
                if (isReplay && hasStream && !hasWindow && program?.start_time && program?.end_time) {
                    if (!preferBase && staleTrigger) {
                        component.__smgNeedShiftBase = true;
                    }
                    const useUrl = preferBase ? baseOk : url;
                    if (preferBase) {
                        component.__smgPreferFreshBaseUntil = 0;
                    }
                    config.url = useUrl + (useUrl.includes('?') ? '&' : '?') +
                        'start=' + program.start_time + '&end=' + program.end_time;
                } else if (isReplay && !hasStream && program?.start_time && program?.end_time) {
                    if (baseOk) {
                        component.__smgPreferFreshBaseUntil = 0;
                        config.url = baseOk + '&start=' + program.start_time + '&end=' + program.end_time;
                        console.log('[SMGTV] 已注入回放 频道' + channelId);
                    } else {
                        component.__smgNeedShiftBase = true;
                    }
                } else if (!isReplay) {
                    if (preferBase) {
                        config.url = baseOk;
                        component.__smgPreferFreshBaseUntil = 0;
                        console.log('[SMGTV] 已注入直播 频道' + channelId + (urlStale ? '（旧地址已过期）' : ''));
                    } else if (!hasStream || staleTrigger) {
                        // 手上没有可用的源，或页面给的这条已经过期：请求重新取源。
                        // 「已过期」这条跟着自动取源的白名单走：非白名单频道拿不到新源，
                        // 而 shift 缓存里可能是从页面回看地址抓来的回看源，贸然注入会播出错内容
                        component.__smgNeedShiftBase = true;
                    }
                }
                return new target(...args);
            }
        });
    }
    function wrapMobileInitPlayer(component) {
        if (!isMobileSite()) return;
        const original = component?.initPlayer;
        if (!original || original.__smgMobileWrapped) return;
        const wrapped = function (opts) {
            if (opts && typeof opts === 'object' && 'url' in opts) {
                const program = this?.programObj;
                const channelId = getCompChannelId(this);
                const current = typeof opts.url === 'string' ? opts.url : '';
                const isReplay = opts.isLive === false;
                // 回看只认回看源；直播要看两个缓存（自动取源只写 shift 缓存）
                const baseEntry = resolveBaseEntry(channelId, isReplay ? 'shift' : '');
                const currentExp = parseStreamExpiry(current);
                const currentStale = !!current && currentExp != null && currentExp - BASE_SAFETY_MS <= Date.now();
                const canInject = !!baseEntry && (!isReplay || (program?.start_time && program?.end_time));
                if ((!current || currentStale) && canInject) {
                    const base = baseEntry.url;
                    if (isReplay) {
                        opts.url = base + (base.includes('?') ? '&' : '?') +
                            'start=' + program.start_time + '&end=' + program.end_time;
                    } else {
                        opts.url = base;
                    }
                    component.__smgPreferFreshBaseUntil = 0;
                    console.log('[SMGTV] 已注入' + (isReplay ? '回放' : '直播') + ' 频道' + channelId);
                } else if ((!current || (currentStale && (isReplay || canAutoAcquire(channelId)))) && channelId != null) {
                    // 手上没有可用的源、或页面给的这条已经过期：请求重新取源。
                    // 原来只在 current 为空时置位，过期地址会被原样放行
                    component.__smgNeedShiftBase = true;
                }
            }
            return original.apply(this, arguments);
        };
        wrapped.__smgMobileWrapped = true;
        component.initPlayer = wrapped;
    }
    function dateStrOffset(daysAgo) {
        const d = new Date(Date.now() - daysAgo * 86400000);
        return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    }
    function findTodayDonorId(component) {
        const lists = [component?.currentProgramList, component?.playingProgramList];
        const isEnded = p => p && p.id && p.isOutDate === 0 && p.play === 0;
        for (const list of lists) {
            if (!Array.isArray(list)) continue;
            for (const p of list) {
                if (isEnded(p) && typeof p.name === 'string' && p.name.indexOf('体育新闻') !== -1) return p.id;
            }
        }
        for (const list of lists) {
            if (!Array.isArray(list)) continue;
            for (const p of list) {
                if (isEnded(p) && p.is_review === 1) return p.id;
            }
        }
        return null;
    }
    function findDonorIdFromList(list) {
        if (!Array.isArray(list)) return null;
        const news = list.find(p => p && p.is_review === 1 && p.id &&
                               typeof p.name === 'string' && p.name.indexOf('体育新闻') !== -1);
        if (news) return news.id;
        const any = list.find(p => p && p.is_review === 1 && p.id);
        return any ? any.id : null;
    }
    function fetchShiftByDonor(channelId, donorId) {
        return smgApiGet('/content/pc/tv/program/detail', { channel_program_id: donorId })
            .then(res => {
            const detail = res && res.result;
            const enc = detail && detail.channel_info && detail.channel_info.shift_address;
            if (!enc) return null;
            return new Promise(resolve => {
                decryptRsaChunks(enc, url => {
                    if (!url) return resolve(null);
                    try {
                        const u = new URL(url);
                        u.searchParams.delete('start');
                        u.searchParams.delete('end');
                        const base = u.toString();
                        // 不解析期限时不要兜底成 12 小时——那正是让过期地址被长期复用的原因
                        channelShiftBaseCache[channelId] = {
                            url: base,
                            at: Date.now(),
                            exp: parseStreamExpiry(url),
                            src: 'script'
                        };
                        console.log('[SMGTV] 已获取回看源');
                        resolve(base);
                    } catch (e) {
                        resolve(null);
                    }
                });
            });
        });
    }
    function acquireShiftBase(channelId, component) {
        let candidate;
        if (component) {
            const todayId = findTodayDonorId(component);
            if (todayId) candidate = todayId;
        }
        if (!candidate) {
            const listPromise = smgApiGet('/content/pc/tv/programs', { channel_id: channelId, date: dateStrOffset(0) });
            return listPromise.then(res => {
                const id = findDonorIdFromList(res && res.result && res.result.programs);
                if (id) return fetchShiftByDonor(channelId, id).then(url => url || scanPast(channelId, 1));
                return scanPast(channelId, 1);
            });
        }
        return fetchShiftByDonor(channelId, candidate).then(url => url || scanPast(channelId, 1));
    }
    function scanPast(channelId, daysAgo) {
        if (daysAgo > 7) {
            console.warn('[SMGTV] 7天内未找到可用的回看源');
            return Promise.resolve(null);
        }
        return smgApiGet('/content/pc/tv/programs', { channel_id: channelId, date: dateStrOffset(daysAgo) })
            .then(res => {
            const id = findDonorIdFromList(res && res.result && res.result.programs);
            if (!id) return scanPast(channelId, daysAgo + 1);
            return fetchShiftByDonor(channelId, id).then(url => {
                if (url) return url;
                return scanPast(channelId, daysAgo + 1);
            });
        });
    }
    // 返回是否真的发起了取源（被冷却/正在取源挡住时返回 false，调用方据此走兜底）
    function maybeAutoCaptureShift(component, fromMonitor, opts) {
        opts = opts || {};
        if (!component || !component.__smgPatched || !component.__smgNeedShiftBase || !fromMonitor) {
            return false;
        }
        const chId = getCompChannelId(component);
        if (chId == null) {
            return false;
        }
        if (!canAutoAcquire(chId)) {
            component.__smgNeedShiftBase = false;
            return false;
        }
        const now = Date.now();
        const hasBase = !!resolveBaseEntry(chId);
        // force 用于“手上这条地址已经失效，必须换一条新的”的场景：
        // 此时即使缓存里还有条目也要重新取，取到的新地址会覆盖旧条目
        if (hasBase && !opts.force) {
            component.__smgNeedShiftBase = false;
            return false;
        }
        const cooldownKey = '__smgShiftCooldown';
        if (component.__smgAcquiring) {
            return false;
        }
        if (now - (component[cooldownKey] || 0) < 60000) {
            return false;
        }
        component[cooldownKey] = now;
        component.__smgAcquiring = true;
        acquireShiftBase(chId, component).then(ok => {
            component.__smgAcquiring = false;
            if (ok) {
                component.__smgNeedShiftBase = false;
                // 注意：这里不重置 __smgAcquireFails。取到一条非空地址不等于它能播，
                // 只看“取到了”就清零会让持续给坏地址的接口无限循环取源。
                // 失败计数改由“画面确实在推进”时清零（见 detectPlaybackFailure）。
                if (component && typeof component.initPlayer === 'function' && opts.rebuild !== false) {
                    // 取源是异步的，快则几十毫秒慢则几秒。进度记录是在发起取源前那一刻记的，
                    // 到这里可能已经吃掉不小一段 90 秒的有效期；重建前重记一次，
                    // 让这个窗口从真正重建的时刻开始算
                    rememberPlaybackPosition(component, getPlayerVideo(component));
                    if (isMobileSite()) {
                        const prog = component.programObj;
                        component.initPlayer({ url: '', isLive: !!(prog && prog.play === 1), autoplay: true });
                    } else {
                        component.initPlayer({ changeCurrentList: false, isPlay: true, trigger: 'click' });
                    }
                }
            } else {
                component.__smgAcquireFails = (component.__smgAcquireFails || 0) + 1;
                if (component.__smgAcquireFails >= 3) {
                    component[cooldownKey] = now + 10 * 60 * 1000;
                    console.warn('[SMGTV] 暂无可用播放源');
                }
            }
        });
        return true;
    }
    // 重新取一条新的播放源。取到的新地址会覆盖缓存里的旧条目，
    // 因此取源失败也不会把手上还能用的地址弄丢。
    function forceRenewStream(component, reason, rebuild) {
        const chId = getCompChannelId(component);
        if (chId == null) {
            return false;
        }
        throttleLog('renew-log', 30000, () => {
            console.log('[SMGTV] 播放源失效（' + reason + '），正在重新获取 频道' + chId);
        });
        component.__smgNeedShiftBase = true;
        if (rebuild) {
            // 让紧随其后的播放器重建优先用新取到的源，而不是页面塞回来的旧地址
            component.__smgPreferFreshBaseUntil = Date.now() + 30000;
        }
        // 返回“是否真的发起了取源”：冷却期内会返回 false，此时调用方需要走兜底重建，
        // 否则日志报了“正在恢复”却什么都没发生
        return maybeAutoCaptureShift(component, true, { force: true, rebuild: rebuild !== false });
    }
    // 断流判定。原来只看 mediaError.code === 4，但 hls.js 在网络中断时
    // 不会写 HTMLMediaElement.error，只会表现为 currentTime 不再前进，
    // 因此两种信号都要看。
    function detectPlaybackFailure(component, video) {
        if (!video) {
            return null;
        }
        // 用户主动暂停 / 播放结束 / 拖动 优先判断：
        // 元素上可能残留一次瞬时错误，不能因此把用户按下的暂停推翻
        if (video.paused || video.ended || video.seeking) {
            component.__smgStallWatch = null;
            clearStuckStart(component);
            return null;
        }
        // 媒体错误要排在 currentTime 判断之前：地址不可播时 currentTime 会一直停在 0，
        // 若被 currentTime<1 提前 return 掉，这个最明确的故障信号就永远看不到了
        const err = video.error;
        // code 1 = MEDIA_ERR_ABORTED，切换 src 时就会出现，不是真的故障
        if (err && err.code !== 1) {
            component.__smgStallWatch = null;
            return '媒体错误 code=' + err.code;
        }
        const now = Date.now();
        if (video.currentTime < 1) {
            // 一直起不来：重建后注入的地址同样不可播时，currentTime 会永远停在 0，
            // 上面所有基于“画面不再前进”的判据都不成立，只能靠一个更长的窗口兜底
            component.__smgStallWatch = null;
            const rs = video.readyState;
            // 计时必须能被打断重来，否则会误伤正常场景：
            //  - 换了播放器 / readyState 回退（重建会把加载推倒重来）
            //  - readyState 前进（说明数据还在到，只是起播慢，弱网下很常见）
            if (component.__smgStuckVideo !== video || component.__smgStuckAt == null ||
                    rs !== (component.__smgStuckReady || 0)) {
                component.__smgStuckVideo = video;
                component.__smgStuckReady = rs;
                component.__smgStuckAt = now;
                return null;
            }
            // 数据完全取不到（NETWORK_NO_SOURCE）：不用等满窗口，这是明确的加载失败
            if (video.networkState === 3) {
                return '源无法加载';
            }
            if (now - component.__smgStuckAt >= STUCK_START_TIMEOUT_MS) {
                return '一直未能起播 ' + Math.round((now - component.__smgStuckAt) / 1000) + ' 秒';
            }
            return null;
        }
        clearStuckStart(component);
        const watch = component.__smgStallWatch;
        if (!watch || watch.video !== video) {
            // 换了播放器元素，基准时钟要重设，但**不能**顺带清零恢复计数：
            // 否则每次重建都会把退避打回最短期，退避形同虚设
            component.__smgStallWatch = { video: video, time: video.currentTime, at: now };
            return null;
        }
        if (video.currentTime > watch.time + 0.25) {
            // 画面确实在向前推进 —— 说明播放正常，恢复计数与取源失败计数一起清零
            component.__smgRecoverCount = 0;
            component.__smgAcquireFails = 0;
            watch.time = video.currentTime;
            watch.at = now;
            return null;
        }
        if (video.currentTime < watch.time - 0.25) {
            // 回退（播放器重建、用户拖动）：只重设基准时钟，不计为“播放正常”，
            // 否则重建后 currentTime 归零会被当成进度，把退避计数清掉
            watch.time = video.currentTime;
            watch.at = now;
            return null;
        }
        if (now - watch.at >= STALL_TIMEOUT_MS) {
            return '画面停滞 ' + Math.round((now - watch.at) / 1000) + ' 秒';
        }
        return null;
    }
    function clearStuckStart(component) {
        component.__smgStuckAt = null;
        component.__smgStuckVideo = null;
        component.__smgStuckReady = 0;
    }
    // 回看重启会从节目开头重新注入整段窗口，先把进度记下来，重建后跳回原处。
    // 记录必须绑定到“被换掉的那个播放器”上：旧播放器在取源期间仍在派发
    // timeupdate，不绑元素的话它会在自己身上把记录消费掉，新播放器就无从恢复。
    function rememberPlaybackPosition(component, video) {
        if (!video || !(video.currentTime > 5)) {
            return;
        }
        component.__smgResumeAt = video.currentTime;
        component.__smgResumeVideo = video;
        component.__smgResumeAt_ts = Date.now();
    }
    function clearResumePosition(component) {
        component.__smgResumeAt = null;
        component.__smgResumeVideo = null;
        component.__smgResumeAt_ts = 0;
    }
    function resumePlaybackPosition(component, video) {
        const at = component.__smgResumeAt;
        if (at == null || !video) {
            return;
        }
        // 记录只在「记下之后马上重建」这个前提下才有意义。取源可能被冷却挡住根本没重建，
        // 记录就会一直留着，之后任何一次无关的重建（同频道换节目等）都会拿它乱跳进度，
        // 所以超过这个窗口的记录直接作废
        if (Date.now() - (component.__smgResumeAt_ts || 0) > RESUME_POSITION_TTL_MS) {
            clearResumePosition(component);
            return;
        }
        // 用户正在拖动进度条：此时 currentTime 会短暂落到记录位置之前，
        // 不拦的话下面会判定成"进度被打回了"并把用户拽回原处
        if (video.seeking) {
            return;
        }
        // 记录是针对被换掉的那个播放器存的。旧播放器在异步取源期间仍在派发 timeupdate，
        // 在那上面消费记录会让重建后的新播放器无从恢复进度。
        // 判据取两种信号：换了 video 元素，或者同一元素的 currentTime 被明显打回
        // （xgplayer 重建时也可能复用同一个元素，只比元素身份会漏掉这种情况）。
        if (component.__smgResumeVideo === video && video.currentTime >= at - 3) {
            return;
        }
        if (video.readyState < 2) {
            return;
        }
        if (!isFinite(video.duration)) {
            // duration 是 NaN 说明元数据还没到位，这时不能把记录清掉，
            // 否则回看的进度会在重建后被永久丢弃（isFinite(NaN) 同样是 false）
            if (!isNaN(video.duration)) {
                // Infinity = 直播流，跳进度没有意义（要的是最新画面）
                clearResumePosition(component);
            }
            return;
        }
        clearResumePosition(component);
        // 记下的位置是针对原来那个节目的。若新播放器的时长比它还短，说明换节目了，
        // 硬跳过去会被浏览器钳到片尾直接播完
        if (at > video.duration - 2) {
            return;
        }
        if (Math.abs(video.currentTime - at) > 3) {
            try {
                video.currentTime = at;
                console.log('[SMGTV] 已恢复到中断前进度 ' + Math.round(at) + 's');
            } catch (e) {}
        }
    }
    function recoverPlayerIfNeeded(component) {
        if (!component || typeof component.initPlayer !== 'function') {
            return;
        }
        const now = Date.now();
        if (now < (component.__smgRecoveringUntil || 0)) {
            return;
        }
        const video = getPlayerVideo(component);
        const reason = detectPlaybackFailure(component, video);
        if (!reason) {
            return;
        }
        // 恢复次数不设上限（原先是 3 次本场直播永久不再恢复），改成逐次拉长的退避：
        // 只要画面恢复推进会立刻清零，所以正常场景永远退避不到很后面
        component.__smgRecoverCount = (component.__smgRecoverCount || 0) + 1;
        const backoff = Math.min(
            RECOVER_COOLDOWN_MS * Math.pow(2, Math.min(component.__smgRecoverCount - 1, 5)),
            RECOVER_MAX_COOLDOWN_MS);
        component.__smgRecoveringUntil = now + backoff;
        // 清掉停滞基准，让重建后的播放器重新计时。
        // 这一步不会再顺带清零恢复计数——清零只发生在「画面确实向前推进」时，
        // 否则每次重建都把退避打回 15 秒，指数退避和 5 分钟上限就永远用不上。
        component.__smgStallWatch = null;
        // 「一直未能起播」的计时属于上一台播放器，重建后要重新开始算
        clearStuckStart(component);
        throttleLog('recover-log', 30000, () => {
            console.log('[SMGTV] 播放中断（' + reason + '），第 ' + component.__smgRecoverCount + ' 次恢复');
        });
        rememberPlaybackPosition(component, video);
        ensurePlayableStream(component);
        // 先换源再重建：只重建而不换源，拿回来的还是那条已经失效的地址。
        // 但若取源正处在冷却期（没真的发起），必须退回裸重建，否则这一轮恢复是空转的。
        if (!forceRenewStream(component, reason, true)) {
            component.initPlayer({ changeCurrentList: false, isPlay: true, trigger: 'click' });
        }
    }
    // 切频道后，上一个频道留下的冷却与失败计数会继续压着新频道
    // （最坏情况切台后 10 分钟无法自动取源），换了频道就清掉
    function resetChannelScopedState(component) {
        const chId = getCompChannelId(component);
        if (chId == null || chId === component.__smgLastChannelId) {
            return;
        }
        component.__smgLastChannelId = chId;
        component.__smgShiftCooldown = 0;
        component.__smgAcquireFails = 0;
        component.__smgAcquiring = false;
        component.__smgNeedShiftBase = false;
        component.__smgLastRenewAt = 0;
        component.__smgLastRenewRebuildAt = 0;
        component.__smgRecoveringUntil = 0;
        component.__smgRecoverCount = 0;
        component.__smgStallWatch = null;
        clearResumePosition(component);
        component.__smgPreferFreshBaseUntil = 0;
        clearStuckStart(component);
    }
    // 主动续期：与其等画面断掉再救，不如在地址到期前就把新源取回来。
    // 只刷新缓存，不重建播放器——重建会打断正在播放的画面。
    function maintainStreamFreshness(component) {
        const chId = getCompChannelId(component);
        if (chId == null) {
            return;
        }
        // 要看的是**正在播放的那一条**。取两个缓存里期限最晚的那条会漏掉回看场景：
        // 先看过直播时 live 缓存里留着一条期限很长的地址，于是回看源快到期了也判定为“还早”，
        // 主动续期就永远不会触发。判断口径必须与注入端 resolveBaseEntry 保持一致。
        const entry = resolveBaseEntry(chId, component.programObj?.play === 0 ? 'shift' : '');
        if (!entry) {
            return;
        }
        const now = Date.now();
        // 提前量按寿命比例收缩：长寿命源用固定的 2 分钟，
        // 短寿命源不能比它自己的寿命还长，否则会一直触发
        const lifetime = Math.max(baseExpiryOf(entry) - (entry.at || 0), 60000);
        const margin = Math.min(STREAM_RENEW_MARGIN_MS, Math.max(lifetime * 0.15, 15000));
        if (baseExpiryOf(entry) - now > margin) {
            return;
        }
        if (now - (component.__smgLastRenewAt || 0) < STREAM_RENEW_COOLDOWN_MS) {
            return;
        }
        component.__smgLastRenewAt = now;
        // 仅在画面还是好的、且距上次重建足够久时才重建播放器，
        // 避免短寿命源被反复打断
        const video = getPlayerVideo(component);
        const playing = isVideoReady(video);
        const rebuildGap = Math.max(60000, lifetime * 0.4);
        const canRebuild = playing && now - (component.__smgLastRenewRebuildAt || 0) >= rebuildGap;
        if (canRebuild) {
            component.__smgLastRenewRebuildAt = now;
            component.__smgPreferFreshBaseUntil = now + 30000;
            rememberPlaybackPosition(component, video);
        }
        forceRenewStream(component, '地址临近到期', canRebuild);
    }
    function injectStyle(cssText) {
        const appendStyle = () => {
            if (document.getElementById(STYLE_ID)) {
                return;
            }
            const style = document.createElement('style');
            style.id = STYLE_ID;
            style.textContent = cssText;
            (document.head || document.documentElement).appendChild(style);
        };
        if (document.head || document.documentElement) {
            appendStyle();
        } else {
            document.addEventListener('DOMContentLoaded', appendStyle, { once: true });
        }
    }
    function ensureViewportFitCover() {
        const apply = () => {
            try {
                const meta = document.querySelector('meta[name="viewport"]');
                if (meta) {
                    const content = meta.getAttribute('content') || '';
                    if (!/viewport-fit\s*=\s*cover/i.test(content)) {
                        meta.setAttribute('content', content ? content + ', viewport-fit=cover' : 'viewport-fit=cover');
                    }
                    return;
                }
                const created = document.createElement('meta');
                created.setAttribute('name', 'viewport');
                created.setAttribute('content', 'width=device-width, initial-scale=1, viewport-fit=cover');
                (document.head || document.documentElement).appendChild(created);
            } catch (e) {
                throttleLog('viewport-error', 5000, () => console.warn('[SMGTV] 设置 viewport-fit 失败:', e));
            }
        };
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', apply, { once: true });
        } else {
            apply();
        }
    }
    function getVueInstance(el) {
        return el?.__vue__ || el?.__vueParentComponent?.proxy || null;
    }
    function isTVComponent(instance) {
        return !!instance && (
            typeof instance.initPlayer === 'function' ||
            typeof instance.playProgram === 'function' ||
            typeof instance.setLiveTimer === 'function' ||
            ('isLoading' in instance && 'player' in instance)
        );
    }
    function findComponentFromElement(el) {
        let current = el;
        while (current) {
            const instance = getVueInstance(current);
            if (isTVComponent(instance)) {
                return instance;
            }
            current = current.parentElement;
        }
        return null;
    }
    function findTVComponent() {
        const selectors = ['.huikan', '.live-container', '.live-box', '.live-player', '.tv', '.player-box'];
        for (const selector of selectors) {
            const component = findComponentFromElement(document.querySelector(selector));
            if (component) {
                return component;
            }
        }
        return null;
    }
    function getPlayerVideo(component) {
        const player = component?.player;
        return player?.video ||
            player?.media ||
            player?.root?.querySelector?.('video') ||
            component?.$refs?.livePlayer?.querySelector?.('video') ||
            document.querySelector('.live-player video, .player-box video, .xgplayer video, video');
    }
    function isVideoReady(video) {
        return !!video && !video.error && (
            video.readyState >= 2 ||
            (!video.paused && video.currentTime > 0)
        );
    }
    function setVideoReadyClass(isReady) {
        const target = document.body || document.documentElement;
        target?.classList?.toggle(VIDEO_READY_CLASS, isReady);
    }
    function syncLoadingState(component) {
        forceOpenProgramList(component);
        maybeAutoCaptureShift(component, false);
        recoverPlayerIfNeeded(component);
        const video = getPlayerVideo(component);
        if (video) {
            watchPlayerVideo(component, video);
        }
        const isReady = isVideoReady(video);
        setVideoReadyClass(isReady);
        if (isReady && component && component.isLoading) {
            component.isLoading = false;
        }
        return isReady;
    }
    function watchPlayerVideo(component, video) {
        if (!video || watchedVideos.has(video)) {
            return;
        }
        watchedVideos.add(video);
        const markReady = () => {
            resumePlaybackPosition(component, video);
            syncLoadingState(component);
        };
        const resetReady = () => {
            if (!isVideoReady(video)) {
                setVideoReadyClass(false);
            }
        };
        VIDEO_READY_EVENTS.forEach(eventName => {
            video.addEventListener(eventName, markReady, { passive: true });
        });
        VIDEO_RESET_EVENTS.forEach(eventName => {
            video.addEventListener(eventName, resetReady, { passive: true });
        });
        video.addEventListener('webkitbeginfullscreen', () => syncFullscreenButtonState(component, true), { passive: true });
        video.addEventListener('webkitendfullscreen', () => syncFullscreenButtonState(component, false), { passive: true });
        markReady();
    }
    function cleanupComponent(component) {
        if (!component) {
            return;
        }
        if (component.__smgLoadingMonitor) {
            clearInterval(component.__smgLoadingMonitor);
            component.__smgLoadingMonitor = null;
        }
        if (component.__smgLoadingObserver) {
            component.__smgLoadingObserver.disconnect();
            component.__smgLoadingObserver = null;
        }
        if (component.pageVisibilityChange) {
            document.removeEventListener('visibilitychange', component.pageVisibilityChange);
        }
    }
    function startLoadingMonitor(component) {
        if (!component || component.__smgLoadingMonitor) {
            return;
        }
        component.__smgLoadingMonitor = setInterval(() => {
            const rootEl = component.$el;
            if (rootEl && !rootEl.isConnected) {
                cleanupComponent(component);
                initComponentPatch();
                return;
            }
            resetChannelScopedState(component);
            maybeAutoCaptureShift(component, true);
            maintainStreamFreshness(component);
            syncLoadingState(component);
        }, 500);
        if (component.$refs?.livePlayer && !component.__smgLoadingObserver) {
            component.__smgLoadingObserver = new MutationObserver(() => syncLoadingState(component));
            component.__smgLoadingObserver.observe(component.$refs.livePlayer, {
                childList: true,
                subtree: true
            });
        }
    }
    function getBrowserFullscreenElement() {
        return document.fullscreenElement ||
            document.webkitFullscreenElement ||
            document.mozFullScreenElement ||
            document.msFullscreenElement ||
            null;
    }
    function requestElementFullscreen(el) {
        if (!el) {
            return Promise.reject(new Error('missing fullscreen target'));
        }
        const request =
              el.requestFullscreen ||
              el.webkitRequestFullscreen ||
              el.webkitRequestFullScreen ||
              el.mozRequestFullScreen ||
              el.msRequestFullscreen;
        if (!request) {
            return Promise.reject(new Error('fullscreen api unavailable'));
        }
        try {
            const result = request.call(el);
            return result && typeof result.then === 'function' ? result : Promise.resolve();
        } catch (e) {
            return Promise.reject(e);
        }
    }
    function exitBrowserFullscreen() {
        const exit =
              document.exitFullscreen ||
              document.webkitExitFullscreen ||
              document.webkitCancelFullScreen ||
              document.mozCancelFullScreen ||
              document.msExitFullscreen;
        if (!exit) {
            return Promise.resolve();
        }
        try {
            const result = exit.call(document);
            return result && typeof result.then === 'function' ? result : Promise.resolve();
        } catch (e) {
            return Promise.reject(e);
        }
    }
    function getFullscreenTarget(component, button) {
        return component?.player?.root ||
            button?.closest?.('.xgplayer') ||
            component?.$refs?.livePlayer?.querySelector?.('.xgplayer') ||
            component?.$refs?.livePlayer ||
            document.querySelector('.live-player .xgplayer, .player-box .xgplayer, .xgplayer, .live-player, .player-box');
    }
    function syncFullscreenButtonState(component, isFullscreen) {
        document.querySelectorAll(FULLSCREEN_BUTTON_SELECTOR).forEach(button => {
            button.setAttribute('data-state', isFullscreen ? 'full' : 'normal');
        });
    }
    function enterFallbackFullscreen(target, component) {
        if (!target) {
            return;
        }
        const player = component?.player;
        if (player && typeof player.getCssFullscreen === 'function') {
            try {
                player.getCssFullscreen(target);
                cssFullscreenFallbackPlayer = player;
                syncFullscreenButtonState(component, true);
                return;
            } catch (e) {
                console.warn('[SMGTV] xgplayer CSS 全屏失败，使用样式兜底', e);
            }
        }
        exitFallbackFullscreen(component);
        fullscreenFallbackTarget = target;
        target.classList.add(FULLSCREEN_TARGET_CLASS);
        document.body?.classList.add(FULLSCREEN_FALLBACK_CLASS);
        syncFullscreenButtonState(component, true);
    }
    function exitFallbackFullscreen(component) {
        const player = component?.player || cssFullscreenFallbackPlayer;
        if (cssFullscreenFallbackPlayer && player && typeof player.exitCssFullscreen === 'function') {
            try {
                player.exitCssFullscreen();
            } catch (e) {
                console.warn('[SMGTV] 退出 xgplayer CSS 全屏失败', e);
            }
        }
        cssFullscreenFallbackPlayer = null;
        if (fullscreenFallbackTarget) {
            fullscreenFallbackTarget.classList.remove(FULLSCREEN_TARGET_CLASS);
            fullscreenFallbackTarget = null;
        }
        document.body?.classList.remove(FULLSCREEN_FALLBACK_CLASS);
        syncFullscreenButtonState(component, false);
    }
    function isFallbackFullscreen() {
        return !!document.body?.classList.contains(FULLSCREEN_FALLBACK_CLASS) ||
            !!cssFullscreenFallbackPlayer?.cssfullscreen ||
            !!cssFullscreenFallbackPlayer?.isCssfullScreen;
    }
    function callFullscreenMethod(fn) {
        try {
            const result = fn();
            return result && typeof result.then === 'function' ? result : Promise.resolve();
        } catch (e) {
            return Promise.reject(e);
        }
    }
    function enterNativeVideoFullscreen(component) {
        const video = getPlayerVideo(component);
        if (!video || typeof video.webkitEnterFullscreen !== 'function') {
            return false;
        }
        try {
            video.webkitEnterFullscreen();
            syncFullscreenButtonState(component, true);
            return true;
        } catch (e) {
            console.warn('[SMGTV] iOS 原生视频全屏失败，使用 CSS 兜底', e);
            return false;
        }
    }
    function enterFullscreen(component, target) {
        const player = component?.player;
        const enterNative = callFullscreenMethod(() => (
            player && typeof player.getFullscreen === 'function' ?
            player.getFullscreen(target) :
            requestElementFullscreen(target)
        ));
        Promise.resolve(enterNative)
            .then(() => syncFullscreenButtonState(component, true))
            .catch(() => {
            if (!enterNativeVideoFullscreen(component)) {
                enterFallbackFullscreen(target, component);
            }
        });
    }
    function exitFullscreen(component) {
        const player = component?.player;
        if (isFallbackFullscreen()) {
            exitFallbackFullscreen(component);
            return;
        }
        const exitNative = callFullscreenMethod(() => (
            player && typeof player.exitFullscreen === 'function' ?
            player.exitFullscreen() :
            exitBrowserFullscreen()
        ));
        Promise.resolve(exitNative)
            .catch(exitBrowserFullscreen)
            .then(
            () => syncFullscreenButtonState(component, false),
            () => syncFullscreenButtonState(component, false)
        );
    }
    function handleFullscreenControl(event) {
        const button = event.target?.closest?.(FULLSCREEN_BUTTON_SELECTOR);
        if (!button) {
            return;
        }
        const now = Date.now();
        if (now - lastFullscreenActionAt < 300) {
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation?.();
            return;
        }
        lastFullscreenActionAt = now;
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();
        const component = findTVComponent();
        const target = getFullscreenTarget(component, button);
        syncLoadingState(component);
        const video = getPlayerVideo(component);
        if (getBrowserFullscreenElement() || isFallbackFullscreen()) {
            exitFullscreen(component);
        } else if (video && video.webkitDisplayingFullscreen) {
            try {
                if (typeof video.webkitExitFullscreen === 'function') {
                    video.webkitExitFullscreen();
                }
            } catch (e) {
                console.warn('[SMGTV] 退出 iOS 原生全屏失败', e);
            }
            syncFullscreenButtonState(component, false);
        } else {
            enterFullscreen(component, target);
        }
    }
    function handleFullscreenChange() {
        if (getBrowserFullscreenElement()) {
            if (isFallbackFullscreen()) {
                exitFallbackFullscreen(findTVComponent());
            }
            syncFullscreenButtonState(findTVComponent(), true);
        } else if (!isFallbackFullscreen()) {
            syncFullscreenButtonState(findTVComponent(), false);
        }
    }
    function initFullscreenPatch() {
        document.addEventListener('click', handleFullscreenControl, true);
        document.addEventListener('touchend', handleFullscreenControl, true);
        document.addEventListener('fullscreenchange', handleFullscreenChange);
        document.addEventListener('webkitfullscreenchange', handleFullscreenChange);
        document.addEventListener('mozfullscreenchange', handleFullscreenChange);
        document.addEventListener('MSFullscreenChange', handleFullscreenChange);
        document.addEventListener('keydown', event => {
            if (event.key === 'Escape' && isFallbackFullscreen()) {
                exitFallbackFullscreen(findTVComponent());
            }
        });
    }
    function wrapComponentMethod(component, methodName, after) {
        const original = component?.[methodName];
        if (typeof original !== 'function' || original.__smgWrapped) {
            return;
        }
        const wrapped = function() {
            const programId = this.programObj?.id;
            if (programId && programId !== this.__smgRecoverProgramId) {
                this.__smgRecoverProgramId = programId;
                this.__smgRecoverCount = 0;
                // 换了节目，上一个节目的进度记录就不再是对这个视频有效的目标，
                // 留着会让下一次重建把新节目拖到旧节目的时间点上
                clearResumePosition(this);
            }
            ensurePlayableStream(this);
            const result = original.apply(this, arguments);
            const runAfter = () => {
                ensurePlayableStream(this);
                setTimeout(() => after(this), 0);
                setTimeout(() => after(this), 250);
                setTimeout(() => after(this), 1000);
            };
            if (result && typeof result.then === 'function') {
                result.then(runAfter, runAfter);
            } else {
                runAfter();
            }
            return result;
        };
        wrapped.__smgWrapped = true;
        wrapped.__smgOriginal = original;
        component[methodName] = wrapped;
    }
    function patchComponent(component) {
        if (!component) {
            return;
        }
        startLoadingMonitor(component);
        if (component.__smgPatched) {
            syncLoadingState(component);
            return;
        }
        component.__smgPatched = true;
        if (typeof component.countdown === 'number') {
            component.countdown = 99999999;
        }
        component.showOpenApp = false;
        component.showFlag = false;
        component.startCountdown = function() {};
        if (component.liveTimer) {
            clearTimeout(component.liveTimer);
            component.liveTimer = null;
        }
        if (!component.player && component.programObj?.id && typeof component.playProgram === 'function') {
            component.playProgram();
        }
        if (typeof component.pageVisibilityChange === 'function') {
            document.removeEventListener('visibilitychange', component.pageVisibilityChange);
            component.pageVisibilityChange = function() {};
            document.addEventListener('visibilitychange', component.pageVisibilityChange);
        }
        if (component._handlerUnload) {
            UW.removeEventListener('unload', component._handlerUnload);
            component._handlerUnload = null;
        }
        ['initPlayer', 'initNoProgramPlayer', 'initPadPlayer', 'changeProgram', 'changeChannel', 'getProgramDetail'].forEach(methodName => {
            wrapComponentMethod(component, methodName, syncLoadingState);
        });
        installReplayUrlPatch(component);
        wrapMobileInitPlayer(component);
        ensurePlayableStream(component);
        const handleProgramList = component.handleProgramList;
        if (typeof handleProgramList === 'function' && !handleProgramList.__smgWrapped) {
            const wrappedList = function(...args) {
                const result = handleProgramList.apply(this, args);
                if (Array.isArray(result)) {
                    result.forEach(program => forceOpenProgram(program));
                }
                return result;
            };
            wrappedList.__smgWrapped = true;
            component.handleProgramList = wrappedList;
        }
        forceOpenProgramList(component);
        syncLoadingState(component);
        if (component.player && !component.player.config?.isPad && component.programObj?.play === 0) {
            const playerUrl = component.player?.config?.url || '';
            if (!/\bstart=\d/.test(playerUrl)) {
                component.initPlayer({ changeCurrentList: false, isPlay: true, trigger: 'auto' });
            }
        }
    }
    let scanning = false;
    function initComponentPatch() {
        if (scanning) {
            return;
        }
        scanning = true;
        let attempts = 0;
        const maxAttempts = 50;
        const timer = setInterval(() => {
            const component = findTVComponent();
            if (component) {
                clearInterval(timer);
                scanning = false;
                patchComponent(component);
                return;
            }
            attempts += 1;
            if (attempts >= maxAttempts) {
                clearInterval(timer);
                scanning = false;
                console.warn('[SMGTV] 未找到播放器组件实例');
            }
        }, 200);
    }
    injectStyle(`
    .video-tip {
        display: none !important;
    }
    body.${VIDEO_READY_CLASS} .loading-mask {
        display: none !important;
        pointer-events: none !important;
    }
    body.${FULLSCREEN_FALLBACK_CLASS} {
        overflow: hidden !important;
    }
    .${FULLSCREEN_TARGET_CLASS} {
        background: #000 !important;
        bottom: 0 !important;
        box-sizing: border-box !important;
        height: 100vh !important;
        height: 100dvh !important;
        inset: 0 !important;
        left: 0 !important;
        margin: 0 !important;
        max-height: none !important;
        max-width: none !important;
        min-height: 100vh !important;
        min-height: 100dvh !important;
        min-width: 100vw !important;
        min-width: 100dvw !important;
        padding: 0 !important;
        position: fixed !important;
        right: 0 !important;
        top: 0 !important;
        transform: none !important;
        width: 100vw !important;
        width: 100dvw !important;
        z-index: 2147483647 !important;
    }
    .${FULLSCREEN_TARGET_CLASS}.xgplayer,
    .${FULLSCREEN_TARGET_CLASS} .xgplayer {
        height: 100% !important;
        inset: 0 !important;
        margin: 0 !important;
        max-height: none !important;
        max-width: none !important;
        padding: 0 !important;
        padding-top: 0 !important;
        position: absolute !important;
        transform: none !important;
        width: 100% !important;
    }
    .${FULLSCREEN_TARGET_CLASS} .xgplayer-screen-container,
    .${FULLSCREEN_TARGET_CLASS} xg-video-container.xg-video-container,
    .${FULLSCREEN_TARGET_CLASS} .xg-video-container {
        bottom: 0 !important;
        display: block !important;
        height: 100% !important;
        inset: 0 !important;
        position: absolute !important;
        width: 100% !important;
    }
    .${FULLSCREEN_TARGET_CLASS} video,
    .${FULLSCREEN_TARGET_CLASS} canvas,
    .${FULLSCREEN_TARGET_CLASS} live-video {
        bottom: 0 !important;
        height: 100% !important;
        left: 0 !important;
        max-height: none !important;
        max-width: none !important;
        object-fit: contain !important;
        position: absolute !important;
        right: 0 !important;
        top: 0 !important;
        transform: none !important;
        width: 100% !important;
    }
    .${FULLSCREEN_TARGET_CLASS} .xgplayer-controls,
    .${FULLSCREEN_TARGET_CLASS} .xg-top-bar {
        z-index: 2147483647 !important;
    }
    .${FULLSCREEN_TARGET_CLASS} .xgplayer-controls {
        padding-bottom: env(safe-area-inset-bottom, 0px) !important;
    }
    .${FULLSCREEN_TARGET_CLASS} .xg-top-bar {
        padding-top: env(safe-area-inset-top, 0px) !important;
    }
    `);
const originalOpen = UW.XMLHttpRequest.prototype.open;
function isTargetTVApi(url) {
    try {
        return new URL(String(url), location.href).pathname.includes('/content/pc/tv/');
    } catch (e) {
        return String(url).includes('/content/pc/tv/');
    }
}
function rewriteTvApiResponse(requestUrl, response) {
    let modified = false;
    if (!response || typeof response !== 'object') {
        return false;
    }
    if (requestUrl.includes('/channel/detail') && response.result) {
        rememberStreamAddresses(
            response.result.id,
            response.result.live_address,
            response.result.shift_address
        );
    }
    if (requestUrl.includes('/program/detail') && response.result) {
        forceOpenProgram(response.result);
        const channelInfo = response.result.channel_info || (response.result.channel_info = {});
        forceOpenProgram(channelInfo);
        const channelId = getResultChannelId(response.result);
        fillStreamAddresses(channelInfo, channelId);
        modified = true;
    }
    if (requestUrl.includes('/programs') && response.result?.programs) {
        response.result.programs.forEach(program => {
            forceOpenProgram(program);
            modified = true;
        });
    }
    return modified;
}
function replaceXhrResponse(xhr, body) {
    try {
        Object.defineProperty(xhr, 'responseText', {
            value: body,
            writable: false,
            configurable: true
        });
        Object.defineProperty(xhr, 'response', {
            value: xhr.responseType === 'json' ? JSON.parse(body) : body,
            writable: false,
            configurable: true
        });
    } catch (e) {
        throttleLog('rewrite-error', 5000, () => console.error('[SMGTV] 重写接口响应失败:', e));
    }
}
UW.XMLHttpRequest.prototype.open = function(method, url) {
    this.__smgRequestUrl = String(url);
    if (isTargetTVApi(this.__smgRequestUrl)) {
        if (!this.__smgHooked) {
            this.__smgHooked = true;
            this.addEventListener('readystatechange', function() {
                if (this.readyState !== 4) {
                    return;
                }
                const requestUrl = this.__smgRequestUrl;
                try {
                    let response;
                    let rawText = null;
                    try {
                        rawText = this.responseText;
                    } catch (e) {
                        rawText = null;
                    }
                    if (typeof rawText === 'string' && rawText) {
                        response = JSON.parse(rawText);
                    } else if (this.response && typeof this.response === 'object') {
                        response = this.response;
                    } else {
                        return;
                    }
                    if (rewriteTvApiResponse(requestUrl, response)) {
                        replaceXhrResponse(this, JSON.stringify(response));
                    }
                } catch (e) {
                    throttleLog('parse-error', 5000, () => console.error('[SMGTV] 解析接口响应失败:', e));
                }
            });
        }
    }
    return originalOpen.apply(this, arguments);
};
const originalFetch = UW.fetch;
if (typeof originalFetch === 'function') {
    UW.fetch = function(input, init) {
        const requestUrl = String(typeof input === 'string' ? input : (input && input.url) || '');
        const request = originalFetch.apply(this, arguments);
        if (!isTargetTVApi(requestUrl)) {
            return request;
        }
        return request.then(res => {
            if (!res) {
                return res;
            }
            try {
                return res.clone().text().then(raw => {
                    try {
                        const response = JSON.parse(raw);
                        if (!rewriteTvApiResponse(requestUrl, response)) {
                            return res;
                        }
                        return new UW.Response(JSON.stringify(response), {
                            status: res.status,
                            statusText: res.statusText,
                            headers: res.headers
                        });
                    } catch (e) {
                        throttleLog('parse-error', 5000, () => console.error('[SMGTV] 解析接口响应失败:', e));
                        return res;
                    }
                }).catch(() => res);
            } catch (e) {
                throttleLog('rewrite-error', 5000, () => console.error('[SMGTV] 重写接口响应失败:', e));
                return res;
            }
        });
    };
}
ensureViewportFitCover();
initComponentPatch();
initFullscreenPatch();
})();
