document.addEventListener('DOMContentLoaded', () => {
    const canvas = document.getElementById('main-canvas');
    const ctx = canvas.getContext('2d');
    // baseCanvas = 背景画像のみ（描画内容は全て shapes[] で管理）
    const baseCanvas = document.createElement('canvas');
    const baseCtx = baseCanvas.getContext('2d');
    // shapesCache = 確定済みシェイプのキャッシュ（高速再描画用）
    // selectedShape を除く全シェイプを事前描画しておき、composite() で1枚の drawImage で済ませる
    const shapesCache = document.createElement('canvas');
    const shapesCacheCtx = shapesCache.getContext('2d');

    const dropZone    = document.getElementById('drop-zone');
    const imageInput  = document.getElementById('image-upload');
    const btnUpload   = document.getElementById('btn-upload');
    const btnSave     = document.getElementById('btn-save');
    const btnClear    = document.getElementById('btn-clear');
    const btnUndo     = document.getElementById('btn-undo');
    const toolBtns    = document.querySelectorAll('.tool-btn');
    const colorBtns   = document.querySelectorAll('.color-btn');
    const brushSizeInput = document.getElementById('brush-size');
    const brushSizeVal   = document.getElementById('brush-size-val');

    // === State ===
    let currentTool = 'pencil', currentColor = '#ffffff', currentSize = 3;
    let isDrawing = false, startX = 0, startY = 0, lastPos = {x:0, y:0};
    let currentPath = []; // ペンシル描画中の点列
    let rafPending = false; // requestAnimationFrame 管理フラグ
    let pendingPreview = null; // rAF で描画する最新プレビュー

    // Panning & Momentum (Transform-based)
    let isPanning = false; 
    let lastMouseX = 0, lastMouseY = 0; // マウスパン用
    let lastTouchX = 0, lastTouchY = 0, lastTouchTime = 0;
    let velX = 0, velY = 0, momentumID = null;
    let moveHistory = [];
    let viewX = 0, viewY = 0, viewScale = 1.0;

    // shapes 配列: 全描画オブジェクトを格納
    // pencil: { type:'pencil', points:[{x,y}...], color, size }
    // line:   { type:'line',   x1,y1,x2,y2, color, size }
    // rect:   { type:'rect',   x,y,w,h,     color, size }
    // text:   { type:'text',   text,x,y,     color, size }
    let shapes = [], selectedShape = null;
    let isDragging = false, dragStartX = 0, dragStartY = 0;
    let undoStack = [];
    const MAX_UNDO = 30;
    let backgroundImage = null, currentZoom = 1.0;
    let lastPinchDistance = null, lastPinchCenter = null;

    // === パフォーマンス最適化用 ===
    let shapesCacheValid = false;       // shapesCache が最新かどうか
    const parseColorCache = {};         // 色文字列 → {r,g,b,a} のキャッシュ
    let lastBaseImageData = null;       // baseCanvas の ImageData 共有参照
    let baseVersion = 0;                // baseCanvas の変更バージョン

    // === Transform ===
    function applyTransform() {
        const container = document.getElementById('canvas-container');
        if (container) container.style.transform = `translate3d(${viewX}px, ${viewY}px, 0) scale(${viewScale})`;
    }

    function setZoom(z, screenX, screenY) {
        const oldS = viewScale;
        viewScale = Math.max(0.1, Math.min(8.0, z));
        currentZoom = viewScale;
        if (screenX !== undefined && screenY !== undefined) {
            const container = document.getElementById('canvas-container');
            const rect = container.getBoundingClientRect();
            const cx = rect.left + rect.width / 2;
            const cy = rect.top  + rect.height / 2;
            viewX += (screenX - cx) * (1 - viewScale / oldS);
            viewY += (screenY - cy) * (1 - viewScale / oldS);
        }
        applyTransform();
    }

    const getDist   = t => Math.hypot(t[0].clientX-t[1].clientX, t[0].clientY-t[1].clientY);
    const getCenter = t => ({x:(t[0].clientX+t[1].clientX)/2, y:(t[0].clientY+t[1].clientY)/2});

    // 画面サイズに合わせてキャンバスを自動フィット＆上寄りに配置
    function fitToScreen() {
        const area = document.querySelector('.canvas-area');
        if (!area || canvas.width === 0 || canvas.height === 0) return;
        const areaW = area.clientWidth;
        const areaH = area.clientHeight;
        if (areaW === 0 || areaH === 0) return;

        const isMobile = window.innerWidth <= 768;
        let scale;

        if (isMobile) {
            // スマホでは横幅に合わせて大きく表示（左右余白16px）
            // チャートや文字が見やすく、すぐ描画・確認できるようにする
            const paddingX = 16;
            scale = (areaW - paddingX) / canvas.width;
            scale = Math.max(0.15, Math.min(2.5, scale));
        } else {
            // PCでは適度な余白を持ちつつ画面内に収める
            const paddingX = 48;
            const paddingY = 48;
            const scaleW = (areaW - paddingX) / canvas.width;
            const scaleH = (areaH - paddingY) / canvas.height;
            scale = Math.min(scaleW, scaleH);
            scale = Math.max(0.2, Math.min(1.5, scale));
        }

        viewScale = currentZoom = scale;

        // 垂直位置: 画面中央（おへそ位置）に寄りすぎるのを防ぎ、ツールバーのすぐ下（上寄り）に配置
        const scaledH = canvas.height * scale;
        const topMargin = isMobile ? 14 : 24;
        viewY = topMargin - (areaH - scaledH) / 2;
        viewX = 0; // 水平方向は中央揃え

        velX = 0;
        velY = 0;
        stopMomentum();
        applyTransform();
    }

    // === Canvas Init ===
    function initCanvas() {
        const mob = window.innerWidth <= 768;
        const w = mob ? 600 : 800;
        const h = mob ? 900 : 800;
        canvas.width = baseCanvas.width = shapesCache.width = w;
        canvas.height = baseCanvas.height = shapesCache.height = h;
        canvas.style.touchAction = 'none';
        canvas.style.cursor = 'crosshair';
        baseCtx.fillStyle = '#ffffff';
        baseCtx.fillRect(0, 0, w, h);
        shapes = []; selectedShape = null; currentPath = [];
        fitToScreen();
        shapesCacheValid = false;
        undoStack = [];
        updateBaseSnapshot();
        saveUndoState();
        composite(); 
    }
    initCanvas();

    // === Composite: baseCanvas + キャッシュ済みシェイプ + プレビュー → メインキャンバス ===
    // 確定済みシェイプはオフスクリーンの shapesCache に描画済みのものを使い回す。
    // これにより、毎フレーム全シェイプを再描画する必要がなくなる。
    function composite(preview) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(baseCanvas, 0, 0);

        // キャッシュが無効なら再構築（selectedShape は除外）
        if (!shapesCacheValid) {
            shapesCacheCtx.clearRect(0, 0, shapesCache.width, shapesCache.height);
            for (let i = 0; i < shapes.length; i++) {
                if (shapes[i] !== selectedShape) {
                    drawObj(shapesCacheCtx, shapes[i], false);
                }
            }
            shapesCacheValid = true;
        }

        // キャッシュ画像を1回の drawImage で描画（O(1)）
        ctx.drawImage(shapesCache, 0, 0);

        // 選択中のシェイプはハイライト付きで個別描画
        if (selectedShape) drawObj(ctx, selectedShape, true);

        // プレビュー（描画中のシェイプ）
        if (preview) drawObj(ctx, preview, false);
    }

    // === rAF スロットル付きプレビュー描画 ===
    // mousemove / touchmove の高頻度イベントを間引いて、
    // ディスプレイのリフレッシュレートに合わせた描画にする
    function schedulePreview(preview) {
        pendingPreview = preview;
        if (!rafPending) {
            rafPending = true;
            requestAnimationFrame(() => {
                if (pendingPreview) composite(pendingPreview);
                pendingPreview = null;
                rafPending = false;
            });
        }
    }

    // === Pencil texture helpers ===
    // シードベースの疑似乱数（描画のたびに同じノイズパターンを再現）
    function seededRandom(seed) {
        let s = seed % 2147483647;
        if (s <= 0) s += 2147483646;
        return () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
    }

    // ポイント列をベジェ曲線で滑らかに描画するヘルパー
    function traceSmooth(tc, points) {
        if (points.length < 2) return;
        tc.beginPath();
        tc.moveTo(points[0].x, points[0].y);
        if (points.length === 2) {
            tc.lineTo(points[1].x, points[1].y);
        } else {
            // 最初のセグメント: 最初の点から、最初と2番目の中点へ
            tc.quadraticCurveTo(
                points[0].x, points[0].y,
                (points[0].x + points[1].x) / 2, (points[0].y + points[1].y) / 2
            );
            // 中間セグメント: 中点から中点へ、各ポイントを制御点として使用
            for (let i = 1; i < points.length - 1; i++) {
                const cpx = points[i].x;
                const cpy = points[i].y;
                const epx = (points[i].x + points[i + 1].x) / 2;
                const epy = (points[i].y + points[i + 1].y) / 2;
                tc.quadraticCurveTo(cpx, cpy, epx, epy);
            }
            // 最後のセグメント: 最後の点へ直接
            const last = points[points.length - 1];
            tc.lineTo(last.x, last.y);
        }
    }

    // 色文字列をRGBA成分に分解（キャッシュ付き）
    // 以前: 毎回 Canvas 要素を生成 → getImageData で色分解（非常に重い）
    // 改善: 一度パースした結果をキャッシュし、同じ色は即座に返す
    function parseColor(c) {
        if (parseColorCache[c]) return parseColorCache[c];
        const d = document.createElement('canvas'); d.width = d.height = 1;
        const x = d.getContext('2d'); x.fillStyle = c; x.fillRect(0,0,1,1);
        const [r,g,b,a] = x.getImageData(0,0,1,1).data;
        parseColorCache[c] = {r,g,b,a};
        return parseColorCache[c];
    }

    // 鉛筆風ストロークを描画（シンプル半透明・ベジェ曲線補間）
    function drawPencilStroke(tc, points, color, size, selected) {
        if (points.length < 2) return;

        const {r, g, b} = parseColor(color);

        if (selected) {
            // 選択時は破線で表示
            tc.save();
            tc.setLineDash([6, 4]);
            tc.lineWidth = size;
            tc.strokeStyle = color;
            tc.lineCap = 'round';
            tc.lineJoin = 'round';
            tc.shadowColor = 'rgba(255,255,255,0.9)';
            tc.shadowBlur = 14;
            traceSmooth(tc, points);
            tc.stroke();
            tc.restore();
            return;
        }

        // --- メインストローク: シンプルな半透明ライン ---
        tc.save();
        tc.strokeStyle = `rgba(${r},${g},${b},0.55)`;
        tc.lineWidth = size;
        tc.lineCap = 'round';
        tc.lineJoin = 'round';
        tc.globalCompositeOperation = 'source-over';
        traceSmooth(tc, points);
        tc.stroke();
        tc.restore();

        // --- 軽いエッジ補強: やや太い半透明で重ね描き ---
        tc.save();
        tc.strokeStyle = `rgba(${r},${g},${b},0.25)`;
        tc.lineWidth = size * 1.5;
        tc.lineCap = 'round';
        tc.lineJoin = 'round';
        traceSmooth(tc, points);
        tc.stroke();
        tc.restore();
    }

    // 直線をポイント列に変換（鉛筆テクスチャ適用用）
    function lineToPoints(x1, y1, x2, y2) {
        const dist = Math.hypot(x2 - x1, y2 - y1);
        const steps = Math.max(2, Math.round(dist / 3));
        const pts = [];
        for (let i = 0; i <= steps; i++) {
            const t = i / steps;
            pts.push({ x: x1 + (x2 - x1) * t, y: y1 + (y2 - y1) * t });
        }
        return pts;
    }

    function drawObj(tc, s, sel) {
        tc.save();
        if (sel && s.type === 'text') { tc.shadowColor = 'rgba(255,255,255,0.9)'; tc.shadowBlur = 14; }

        if (s.type === 'pencil') {
            drawPencilStroke(tc, s.points, s.color, s.size, sel);

        } else if (s.type === 'line') {
            const pts = lineToPoints(s.x1, s.y1, s.x2, s.y2);
            drawPencilStroke(tc, pts, s.color, s.size, sel);

        } else if (s.type === 'rect') {
            const { x, y, w, h, color, size } = s;
            const edges = [
                lineToPoints(x, y, x + w, y),
                lineToPoints(x + w, y, x + w, y + h),
                lineToPoints(x + w, y + h, x, y + h),
                lineToPoints(x, y + h, x, y)
            ];
            edges.forEach(pts => drawPencilStroke(tc, pts, color, size, sel));

        } else if (s.type === 'text') {
            const fontSize = s.size * 4;
            const lineH = fontSize * 1.2;
            tc.font = `${fontSize}px Inter, sans-serif`;
            tc.fillStyle = s.color;
            s.text.split('\n').forEach((l, i) => tc.fillText(l, s.x, s.y + i * lineH));
            if (sel) {
                // 選択時: テキスト周りを破線ボックスで表示
                const lines = s.text.split('\n');
                const estW = lines.reduce((m, l) => Math.max(m, l.length * fontSize * 0.6), 20);
                const h = lines.length * lineH;
                tc.setLineDash([4, 3]);
                tc.strokeStyle = 'rgba(255,255,255,0.85)';
                tc.lineWidth = 1.5;
                tc.shadowBlur = 0;
                tc.strokeRect(s.x - 5, s.y - fontSize - 5, estW + 10, h + 10);
            }
        }
        tc.restore();
    }

    // === Undo ===
    function cloneID(id) { return new ImageData(new Uint8ClampedArray(id.data), id.width, id.height); }
    function cloneShapes(arr) {
        return arr.map(s => s.type === 'pencil' ? {...s, points: s.points.map(p=>({...p}))} : {...s});
    }

    // baseCanvas が変更されたときだけ ImageData をスナップショット
    function updateBaseSnapshot() {
        baseVersion++;
        lastBaseImageData = cloneID(baseCtx.getImageData(0, 0, baseCanvas.width, baseCanvas.height));
    }

    function saveUndoState() {
        undoStack.push({
            base: lastBaseImageData,  // 共有参照（base が変わらない限りコピー不要）
            baseVer: baseVersion,
            shapes: cloneShapes(shapes)
        });
        if (undoStack.length > MAX_UNDO) undoStack.shift();
        shapesCacheValid = false;
        updateUndoBtn();
    }

    function undo() {
        if (undoStack.length <= 1) return;
        undoStack.pop();
        const p = undoStack[undoStack.length - 1];
        // base が異なるバージョンの場合のみ復元
        if (p.baseVer !== baseVersion) {
            baseCtx.putImageData(cloneID(p.base), 0, 0);
            baseVersion = p.baseVer;
            lastBaseImageData = p.base;
        }
        shapes = cloneShapes(p.shapes);
        selectedShape = null;
        shapesCacheValid = false;
        composite();
        updateUndoBtn();
    }
    function updateUndoBtn() { if (btnUndo) btnUndo.disabled = undoStack.length <= 1; }

    // === Hit Test ===
    function distToSeg(px, py, x1, y1, x2, y2) {
        const dx=x2-x1, dy=y2-y1, l=dx*dx+dy*dy;
        if (!l) return Math.hypot(px-x1, py-y1);
        const t = Math.max(0, Math.min(1, ((px-x1)*dx+(py-y1)*dy)/l));
        return Math.hypot(px-(x1+t*dx), py-(y1+t*dy));
    }

    function hitTest(px, py) {
        for (let i = shapes.length - 1; i >= 0; i--) {
            const s = shapes[i];
            const thr = Math.max(s.size / 2 + 10, 14);

            if (s.type === 'pencil') {
                const step = Math.max(1, Math.floor(s.points.length / 80));
                for (let j = 0; j < s.points.length - 1; j += step) {
                    if (distToSeg(px, py, s.points[j].x, s.points[j].y, s.points[j+1].x, s.points[j+1].y) <= thr) return s;
                }
            } else if (s.type === 'line') {
                if (distToSeg(px, py, s.x1, s.y1, s.x2, s.y2) <= thr) return s;
            } else if (s.type === 'rect') {
                const { x, y, w, h } = s;
                const edges = [
                    [x, y, x + w, y],
                    [x + w, y, x + w, y + h],
                    [x + w, y + h, x, y + h],
                    [x, y + h, x, y]
                ];
                if (edges.some(([x1, y1, x2, y2]) => distToSeg(px, py, x1, y1, x2, y2) <= thr)) return s;
            } else if (s.type === 'text') {
                const fontSize = s.size * 4;
                const lineH = fontSize * 1.2;
                const lines = s.text.split('\n');
                const estW = lines.reduce((m, l) => Math.max(m, l.length * fontSize * 0.6), 20);
                const h = lines.length * lineH;
                if (px >= s.x-14 && px <= s.x+estW+14 && py >= s.y-fontSize-14 && py <= s.y+h+14) return s;
            }
        }
        return null;
    }

    function moveShape(s, dx, dy) {
        if (s.type === 'line')   { s.x1+=dx; s.y1+=dy; s.x2+=dx; s.y2+=dy; }
        if (s.type === 'rect')   { s.x+=dx; s.y+=dy; }
        if (s.type === 'pencil') { s.points = s.points.map(p => ({x:p.x+dx, y:p.y+dy})); }
        if (s.type === 'text')   { s.x+=dx; s.y+=dy; }
    }

    // === Text Input Overlay ===
    function addTextInput(x, y) {
        const ex = document.getElementById('temp-text-input');
        if (ex) ex.remove();
        const input = document.createElement('textarea');
        input.id = 'temp-text-input';
        input.placeholder = '文字を入力\n(枠外クリックで確定)';
        input.rows = 1;
        const container = document.getElementById('canvas-container');
        const scaleX = canvas.offsetWidth / canvas.width;
        const fontSize = currentSize * 4 * scaleX;
        Object.assign(input.style, {
            position:'absolute', left:`${x*scaleX}px`, top:`${y*(canvas.offsetHeight/canvas.height)}px`,
            font:`${fontSize}px Inter,sans-serif`, color:currentColor,
            background:'rgba(30,30,35,0.9)', border:'2px solid '+currentColor,
            borderRadius:'4px', outline:'none', zIndex:'1000',
            padding:'4px 8px', minWidth:'4em', resize:'none', overflow:'hidden', whiteSpace:'pre',
            willChange: 'transform'
        });
        container.appendChild(input);
        const msr = document.createElement('span');
        msr.style.cssText = `position:absolute;visibility:hidden;white-space:pre;font:${fontSize}px Inter,sans-serif;padding:4px 8px;left:-9999px;top:-9999px;`;
        document.body.appendChild(msr);
        function resize() {
            const lines = input.value ? input.value.split('\n') : ['\u00A0'];
            let maxW = 0;
            lines.forEach(l => { msr.textContent = l||'\u00A0'; maxW = Math.max(maxW, msr.offsetWidth); });
            input.style.width = (maxW+24)+'px';
            input.style.height = 'auto';
            input.style.height = input.scrollHeight+'px';
        }
        setTimeout(() => { input.focus(); resize(); }, 10);
        input.addEventListener('input', resize);
        const finish = () => {
            if (input.value && input.value !== input.placeholder) {
                // テキストをシェイプオブジェクトとして格納（移動可能）
                shapes.push({ type:'text', text:input.value, x, y:y+currentSize*3, color:currentColor, size:currentSize });
                shapesCacheValid = false;
                composite(); saveUndoState();
            }
            msr.remove(); input.remove();
        };
        input.addEventListener('keydown', e => {
            if (e.key==='Enter' && e.ctrlKey) finish();
            if (e.key==='Escape') { msr.remove(); input.remove(); }
        });
        const outside = e => {
            if (e.target !== input) {
                finish();
                document.removeEventListener('mousedown', outside);
                document.removeEventListener('touchstart', outside);
            }
        };
        setTimeout(() => {
            document.addEventListener('mousedown', outside);
            document.addEventListener('touchstart', outside);
        }, 50);
    }

    // === Pointer ===
    function getPos(e) {
        const rect = canvas.getBoundingClientRect();
        let cx = e.clientX, cy = e.clientY;
        if (e.touches && e.touches.length > 0) {
            cx = e.touches[0].clientX;
            cy = e.touches[0].clientY;
        } else if (e.changedTouches && e.changedTouches.length > 0) {
            cx = e.changedTouches[0].clientX;
            cy = e.changedTouches[0].clientY;
        }
        return { x:(cx-rect.left)*(canvas.width/rect.width), y:(cy-rect.top)*(canvas.height/rect.height) };
    }

    // clientX/clientY からキャンバス座標へ変換（coalesced events用）
    function clientToCanvas(clientX, clientY) {
        const rect = canvas.getBoundingClientRect();
        return { x:(clientX-rect.left)*(canvas.width/rect.width), y:(clientY-rect.top)*(canvas.height/rect.height) };
    }

    function startDraw(e) {
        const pos = getPos(e); lastPos = pos;
        
        // --- PC/マウス操作のパン開始 ---
        // 右クリック(button===2)またはミドルクリック(button===1)はどのツールでも画像パンを開始
        // 移動ツールで背景を左クリックした場合もパン
        if (e.button !== undefined) {
            if (e.button === 2 || e.button === 1) {
                isPanning = true;
                lastMouseX = e.clientX;
                lastMouseY = e.clientY;
                canvas.style.cursor = 'move';
                return;
            }
            if (currentTool === 'move' && e.button === 0) {
                const hit = hitTest(pos.x, pos.y);
                if (!hit) {
                    isPanning = true;
                    lastMouseX = e.clientX;
                    lastMouseY = e.clientY;
                    canvas.style.cursor = 'move';
                    return;
                }
            }
            // 左クリック(0)以外では描画を開始しない
            if (e.button !== 0) return;
        }

        if (currentTool === 'text') { addTextInput(pos.x, pos.y); return; }
        if (currentTool === 'move') {
            const hit = hitTest(pos.x, pos.y);
            const prevSelected = selectedShape;
            selectedShape = hit || null; isDragging = !!hit;
            dragStartX = pos.x; dragStartY = pos.y;
            canvas.style.cursor = hit ? 'grabbing' : 'default';
            // 選択状態が変わったらキャッシュ無効化（選択シェイプはキャッシュ対象外のため）
            if (prevSelected !== selectedShape) shapesCacheValid = false;
            composite(); return;
        }
        isDrawing = true; startX = pos.x; startY = pos.y;
        if (currentTool === 'pencil') {
            currentPath = [{x:startX, y:startY}];
        }
    }

    function draw(e) {
        // マウスによるパンニング (e.button または MouseEvent 判定)
        if (isPanning && e instanceof MouseEvent) {
            const dx = e.clientX - lastMouseX;
            const dy = e.clientY - lastMouseY;
            viewX += dx; viewY += dy;
            lastMouseX = e.clientX; lastMouseY = e.clientY;
            applyTransform();
            return;
        }

        const pos = getPos(e);
        if (currentTool === 'move') {
            if (isDragging && selectedShape) {
                const dx = pos.x - dragStartX;
                const dy = pos.y - dragStartY;
                dragStartX = pos.x; dragStartY = pos.y;
                moveShape(selectedShape, dx, dy);
                // selectedShape はキャッシュに含まれないため、キャッシュは有効のまま
                if (!rafPending) {
                    rafPending = true;
                    requestAnimationFrame(() => { composite(); rafPending = false; });
                }
            } else if (!isDragging) {
                if (e.target === canvas) canvas.style.cursor = hitTest(pos.x, pos.y) ? 'move' : 'default';
            }
            return;
        }
        if (!isDrawing) return;
        lastPos = pos;

        // ペンシルのポイントは同期的に追加（全 mousemove イベントを捕捉）
        if (currentTool === 'pencil') {
            currentPath.push(pos);
        }

        // プレビュー描画は rAF でスロットル
        if (currentTool === 'pencil') {
            schedulePreview({ type:'pencil', points:currentPath, color:currentColor, size:currentSize });
        } else if (currentTool === 'line') {
            schedulePreview({ type:'line', x1:startX, y1:startY, x2:pos.x, y2:pos.y, color:currentColor, size:currentSize });
        } else if (currentTool === 'rect') {
            let w = pos.x - startX, h = pos.y - startY;
            if (e.shiftKey) {
                const side = Math.max(Math.abs(w), Math.abs(h));
                w = (w < 0 ? -1 : 1) * side;
                h = (h < 0 ? -1 : 1) * side;
            }
            const rx = w < 0 ? startX + w : startX;
            const ry = h < 0 ? startY + h : startY;
            const rw = Math.abs(w);
            const rh = Math.abs(h);
            if (rw > 0 && rh > 0) schedulePreview({ type:'rect', x:rx, y:ry, w:rw, h:rh, color:currentColor, size:currentSize });
        }
    }

    function stopDraw() {
        if (isPanning) {
            isPanning = false;
            canvas.style.cursor = (currentTool === 'move') ? 'default' : 'crosshair';
            return;
        }
        if (currentTool === 'move') {
            if (isDragging && selectedShape) {
                shapesCacheValid = false;
                saveUndoState();
            }
            isDragging = false;
            canvas.style.cursor = selectedShape ? 'move' : 'default';
            return;
        }
        if (!isDrawing) return;
        isDrawing = false;
        if (currentTool === 'pencil') {
            if (currentPath.length >= 2) {
                shapes.push({ type:'pencil', points:[...currentPath], color:currentColor, size:currentSize });
                shapesCacheValid = false;
                composite(); saveUndoState();
            }
            currentPath = [];
        } else if (currentTool === 'line') {
            if (lastPos.x !== startX || lastPos.y !== startY) {
                shapes.push({ type:'line', x1:startX, y1:startY, x2:lastPos.x, y2:lastPos.y, color:currentColor, size:currentSize });
                shapesCacheValid = false;
                composite(); saveUndoState();
            }
        } else if (currentTool === 'rect') {
            let w = lastPos.x - startX, h = lastPos.y - startY;
            const rx = w < 0 ? startX + w : startX;
            const ry = h < 0 ? startY + h : startY;
            const rw = Math.abs(w);
            const rh = Math.abs(h);
            if (rw > 0 && rh > 0) {
                shapes.push({ type:'rect', x:rx, y:ry, w:rw, h:rh, color:currentColor, size:currentSize });
                shapesCacheValid = false;
                composite(); saveUndoState();
            }
        }
    }

    // === Image / Save / Clear ===
    function handleImage(file) {
        if (!file || !file.type.startsWith('image/')) return;
        const el = document.getElementById('upload-filename');
        if (el) { el.textContent = file.name; el.title = file.name; }
        const reader = new FileReader();
        reader.onload = ev => {
            const img = new Image();
            img.onload = () => {
                backgroundImage = img;
                const MAX = 3000;
                let w = img.width, h = img.height;
                if (w>MAX){h*=MAX/w;w=MAX;} if (h>MAX){w*=MAX/h;h=MAX;}
                canvas.width = baseCanvas.width = shapesCache.width = Math.round(w);
                canvas.height = baseCanvas.height = shapesCache.height = Math.round(h);
                baseCtx.drawImage(img, 0, 0, Math.round(w), Math.round(h));
                shapes = []; selectedShape = null; currentPath = [];
                // ビューを画面サイズに合わせてリセット＆自動フィット
                fitToScreen();
                shapesCacheValid = false;
                undoStack = [];
                updateBaseSnapshot();
                saveUndoState();
                composite();
                dropZone.classList.add('hidden');
            };
            img.src = ev.target.result;
        };
        reader.readAsDataURL(file);
    }

    function saveImage() {
        composite();
        const a = document.createElement('a');
        a.download = `paint-edit-${Date.now()}.png`;
        a.href = canvas.toDataURL(); a.click();
    }

    function clearCanvas() {
        if (!confirm('キャンバスをクリアしますか？')) return;
        if (backgroundImage) {
            baseCtx.drawImage(backgroundImage, 0, 0, baseCanvas.width, baseCanvas.height);
        } else {
            baseCtx.fillStyle = '#ffffff';
            baseCtx.fillRect(0, 0, baseCanvas.width, baseCanvas.height);
        }
        shapes = []; selectedShape = null; currentPath = [];
        shapesCacheValid = false;
        updateBaseSnapshot();
        composite(); saveUndoState();
    }

    // === Event Listeners ===
    toolBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            toolBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            const map = {'btn-pencil':'pencil','btn-line':'line','btn-rect':'rect','btn-text':'text','btn-move':'move'};
            const lbl = {pencil:'Pencil',line:'Line',rect:'Rectangle',text:'Text',move:'Move'};
            currentTool = map[btn.id] || 'pencil';
            document.getElementById('tool-status').innerText = `Mode: ${lbl[currentTool]}`;
            if (currentTool === 'move') {
                if (selectedShape) shapesCacheValid = false;
                selectedShape = null; composite();
                canvas.style.cursor = 'default';
                canvas.style.touchAction = 'none'; // 移動ツールも pan は不要
            } else {
                if (selectedShape) {
                    selectedShape = null;
                    shapesCacheValid = false;
                    composite();
                }
                canvas.style.touchAction = 'none';
                canvas.style.cursor = 'crosshair';
            }
        });
    });

    colorBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            colorBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentColor = btn.dataset.color;
        });
    });

    brushSizeInput.addEventListener('input', e => {
        currentSize = parseInt(e.target.value);
        brushSizeVal.innerText = `${currentSize}px`;
    });

    document.getElementById('btn-brush-dec').addEventListener('click', () => {
        brushSizeInput.value = Math.max(1, parseInt(brushSizeInput.value) - 1);
        brushSizeInput.dispatchEvent(new Event('input'));
    });
    document.getElementById('btn-brush-inc').addEventListener('click', () => {
        brushSizeInput.value = Math.min(50, parseInt(brushSizeInput.value) + 1);
        brushSizeInput.dispatchEvent(new Event('input'));
    });

    btnUpload.addEventListener('click', () => imageInput.click());
    imageInput.addEventListener('change', e => {
        const file = e.target.files[0];
        if (!file) {
            const el = document.getElementById('upload-filename');
            if (el) { el.textContent = ''; el.title = ''; }
        }
        handleImage(file);
        // 同じファイルを再選択できるようにリセット
        e.target.value = '';
    });
    btnSave.addEventListener('click', saveImage);
    btnClear.addEventListener('click', clearCanvas);
    if (btnUndo) btnUndo.addEventListener('click', undo);

    document.addEventListener('keydown', e => {
        if ((e.ctrlKey||e.metaKey) && e.key==='z') { e.preventDefault(); undo(); }
        if ((e.key==='Delete'||e.key==='Backspace') && selectedShape && currentTool==='move') {
            shapes = shapes.filter(s => s !== selectedShape);
            selectedShape = null;
            shapesCacheValid = false;
            composite(); saveUndoState();
        }
    });

    // Drag & Drop
    window.addEventListener('dragover', e => { e.preventDefault(); if (!backgroundImage) dropZone.classList.remove('hidden'); });
    window.addEventListener('dragleave', e => { 
        if (e.relatedTarget === null || e.relatedTarget === undefined) {
             // 画面外に出た場合のみ表示（オプション）
        }
    });
    window.addEventListener('drop', e => { 
        e.preventDefault(); 
        if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
            handleImage(e.dataTransfer.files[0]); 
        }
    });
    dropZone.addEventListener('click', (e) => { 
        e.stopPropagation();
        imageInput.click(); 
    });

    // Mouse
    canvas.addEventListener('mousedown', startDraw);
    window.addEventListener('mousemove', draw);
    window.addEventListener('mouseup', stopDraw);
    canvas.addEventListener('contextmenu', e => e.preventDefault());

    // キャンバス外側のエリアでも右クリックまたはホイールクリックで画像全体をドラッグ移動可能に
    const canvasArea = document.querySelector('.canvas-area');
    if (canvasArea) {
        canvasArea.addEventListener('mousedown', e => {
            if (e.target !== canvas && (e.button === 2 || e.button === 1)) {
                isPanning = true;
                lastMouseX = e.clientX;
                lastMouseY = e.clientY;
                canvas.style.cursor = 'move';
            }
        });
        canvasArea.addEventListener('contextmenu', e => e.preventDefault());
    }

    // --- Momentum Panning ---
    function stopMomentum() { if (momentumID) { cancelAnimationFrame(momentumID); momentumID = null; } }
    function startMomentum() {
        if (Math.abs(velX) < 0.1 && Math.abs(velY) < 0.1) {
            velX = 0; velY = 0; return;
        }
        viewX += velX;
        viewY += velY;
        applyTransform();
        velX *= 0.97; velY *= 0.97; // 摩擦を少し減らしてより滑らかな慣性に
        momentumID = requestAnimationFrame(startMomentum);
    }

    function updateVelocity(dx, dy, dt) {
        if (dt <= 0) return;
        const currentVelX = (dx / dt) * 16.6;
        const currentVelY = (dy / dt) * 16.6;
        if (Math.abs(velX) < 0.1 && Math.abs(velY) < 0.1) {
            velX = currentVelX; velY = currentVelY;
        } else {
            // ローパスフィルタで速度変化を滑らかにする
            velX = velX * 0.7 + currentVelX * 0.3;
            velY = velY * 0.7 + currentVelY * 0.3;
        }
    }

    // --- Touch（1本指=描画/移動/余白パン、2本指=ピンチズーム＆パン） ---
    function onTouchStart(e) {
        stopMomentum();
        if (e.touches.length === 1) {
            const t = e.touches[0];
            lastTouchX = t.clientX; lastTouchY = t.clientY;
            lastTouchTime = Date.now();
            velX = 0; velY = 0; moveHistory = [];

            // タッチ位置がキャンバス枠内かどうかを判定
            const rect = canvas.getBoundingClientRect();
            const isInsideCanvas = (
                t.clientX >= rect.left && t.clientX <= rect.right &&
                t.clientY >= rect.top && t.clientY <= rect.bottom
            );

            if (currentTool === 'move') {
                e.preventDefault();
                const pos = getPos(e);
                const hit = isInsideCanvas ? hitTest(pos.x, pos.y) : null;
                if (hit) {
                    const prevSelected = selectedShape;
                    selectedShape = hit; isDragging = true;
                    dragStartX = pos.x; dragStartY = pos.y;
                    canvas.style.cursor = 'grabbing';
                    if (prevSelected !== selectedShape) shapesCacheValid = false;
                    composite();
                } else {
                    // 背景や余白タッチならパンモードへ
                    const prevSelected = selectedShape;
                    selectedShape = null; isDragging = false;
                    isPanning = true;
                    if (prevSelected !== null) shapesCacheValid = false;
                    composite();
                }
                return;
            }

            // 描画ツールの場合:
            // キャンバス内なら描画開始、余白（キャンバス外）ならパンを開始
            if (isInsideCanvas) {
                e.preventDefault();
                startDraw(e);
            } else {
                // 余白を触った場合は描画せずパン
                e.preventDefault();
                isPanning = true;
                isDrawing = false;
            }
        } else if (e.touches.length >= 2) {
            e.preventDefault();
            lastPinchDistance = getDist(e.touches);
            lastPinchCenter   = getCenter(e.touches);
            if (isDrawing) {
                // 2本指以上で触れた場合、意図しない描画のあとを残さずキャンセルする
                isDrawing = false;
                currentPath = [];
                composite(); // 未確定のプレビュー線を消去
            }
            isPanning = false; isDragging = false;
        }
    }

    function onTouchMove(e) {
        // 常にブラウザデフォルトのスクロール・ピンチズーム・pull-to-refreshをブロック
        if (e.cancelable) e.preventDefault();

        if (e.touches.length === 1) {
            const t = e.touches[0];
            const now = Date.now();
            const dt = now - lastTouchTime;
            const dx = t.clientX - lastTouchX;
            const dy = t.clientY - lastTouchY;

            if (isPanning) {
                // 指と等倍(1.0)でダイレクトに動かす
                viewX += dx;
                viewY += dy;
                applyTransform();
                updateVelocity(dx, dy, dt);
                lastTouchX = t.clientX; lastTouchY = t.clientY;
                lastTouchTime = now;
                return;
            }

            if (currentTool === 'move') {
                if (isDragging && selectedShape) {
                    draw(e); // シェイプ移動
                }
                lastTouchX = t.clientX; lastTouchY = t.clientY;
                lastTouchTime = now;
                return;
            }

            // ペンシルツール: タッチ間を補間して滑らかにする
            if (currentTool === 'pencil' && isDrawing) {
                const pos = clientToCanvas(t.clientX, t.clientY);
                if (currentPath.length > 0) {
                    const prev = currentPath[currentPath.length - 1];
                    const segDist = Math.hypot(pos.x - prev.x, pos.y - prev.y);
                    const INTERPOLATION_THRESHOLD = 8;
                    if (segDist > INTERPOLATION_THRESHOLD) {
                        const steps = Math.ceil(segDist / INTERPOLATION_THRESHOLD);
                        for (let si = 1; si < steps; si++) {
                            const frac = si / steps;
                            currentPath.push({
                                x: prev.x + (pos.x - prev.x) * frac,
                                y: prev.y + (pos.y - prev.y) * frac
                            });
                        }
                    }
                }
                currentPath.push(pos);
                lastPos = pos;
                schedulePreview({ type:'pencil', points:currentPath, color:currentColor, size:currentSize });
            } else if (isDrawing) {
                draw(e);
            }
            lastTouchX = t.clientX; lastTouchY = t.clientY;
        } else if (e.touches.length === 2 && lastPinchDistance !== null && lastPinchCenter !== null) {
            const d = getDist(e.touches), c = getCenter(e.touches);
            const deltaX = c.x - lastPinchCenter.x;
            const deltaY = c.y - lastPinchCenter.y;
            
            // 指の距離比から新しいスケールを計算（ブレなくスムーズに吸い付く）
            const scaleFactor = d / lastPinchDistance;
            const oldS = viewScale;
            const newScale = Math.max(0.1, Math.min(8.0, oldS * scaleFactor));
            
            // ズーム中心(c.x, c.y)を固定したままスケール変化と中心移動を同時に適用
            const container = document.getElementById('canvas-container');
            if (container && oldS > 0) {
                const rect = container.getBoundingClientRect();
                const cx = rect.left + rect.width / 2;
                const cy = rect.top  + rect.height / 2;
                viewX += deltaX + (c.x - cx) * (1 - newScale / oldS);
                viewY += deltaY + (c.y - cy) * (1 - newScale / oldS);
                viewScale = currentZoom = newScale;
                applyTransform();
            }

            lastPinchCenter = c;
            lastPinchDistance = d;
        }
    }

    function onTouchEnd(e) {
        if (isPanning) {
            isPanning = false;
            // 指を止めてから離した場合は慣性をリセット
            if (Date.now() - lastTouchTime > 50) {
                velX = 0; velY = 0;
            }
            startMomentum();
        }
        if (e.touches.length < 2) { 
            lastPinchDistance = null; 
            lastPinchCenter = null; 
        }
        if (e.touches.length === 0) { 
            isPanning = false; 
            stopDraw(); 
        }
    }

    // キャンバスおよび余白エリア全体でタッチイベントを受け付ける
    const touchTarget = canvasArea || canvas;
    touchTarget.addEventListener('touchstart', onTouchStart, { passive: false });
    window.addEventListener('touchmove', onTouchMove, { passive: false });
    window.addEventListener('touchend', onTouchEnd, { passive: false });
    window.addEventListener('touchcancel', onTouchEnd, { passive: false });

    // Wheel Zoom & Pan (2-finger touchpad support on PC)
    document.querySelector('.canvas-area').addEventListener('wheel', e => {
        e.preventDefault();
        if (e.ctrlKey) {
            // ピンチズーム or Ctrl+Wheel: deltaYをピクセル換算して滑らかに
            // deltaMode: 0=px, 1=line, 2=page
            const delta = e.deltaMode === 1 ? e.deltaY * 20
                        : e.deltaMode === 2 ? e.deltaY * 300
                        : e.deltaY;
            // タッチパッドは小さい値が連続して来るので線形スケールで感度調整
            const factor = Math.exp(-delta * 0.003);
            setZoom(viewScale * factor, e.clientX, e.clientY);
        } else {
            // 2本指スワイプ (パン)
            const mult = e.deltaMode === 1 ? 20 : e.deltaMode === 2 ? 300 : 1;
            viewX -= e.deltaX * mult;
            viewY -= e.deltaY * mult;
            applyTransform();
        }
    }, { passive:false });

    // Mobile check
    function checkMobile() { document.body.classList.toggle('mobile-view', window.innerWidth <= 768); }
    window.addEventListener('resize', checkMobile);
    checkMobile();
});
