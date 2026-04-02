document.addEventListener('DOMContentLoaded', () => {
    const canvas = document.getElementById('main-canvas');
    const ctx = canvas.getContext('2d');
    // baseCanvas = 背景画像のみ（描画内容は全て shapes[] で管理）
    const baseCanvas = document.createElement('canvas');
    const baseCtx = baseCanvas.getContext('2d');

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
    let currentTool = 'pencil', currentColor = '#ff4d4d', currentSize = 5;
    let isDrawing = false, startX = 0, startY = 0, lastPos = {x:0, y:0};
    let currentPath = []; // ペンシル描画中の点列
    let rafPending = false; // requestAnimationFrame 管理フラグ

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
    // circle: { type:'circle', cx,cy,rx,ry,  color, size }
    // text:   { type:'text',   text,x,y,     color, size }
    let shapes = [], selectedShape = null;
    let isDragging = false, dragStartX = 0, dragStartY = 0;
    let undoStack = [];
    const MAX_UNDO = 30;
    let backgroundImage = null, currentZoom = 1.0;
    let lastPinchDistance = null, lastPinchCenter = null;

    // === Transform ===
    function applyTransform() {
        const container = document.getElementById('canvas-container');
        if (container) container.style.transform = `translate3d(${viewX}px, ${viewY}px, 0) scale(${viewScale})`;
    }

    function setZoom(z, centerX, centerY) {
        const oldS = viewScale;
        viewScale = Math.max(0.1, Math.min(8.0, z));
        currentZoom = viewScale; // 同期
        if (centerX !== undefined && centerY !== undefined) {
            // スケール変更に合わせてオフセットを調整（焦点固定）
            viewX -= (centerX - viewX) * (viewScale / oldS - 1);
            viewY -= (centerY - viewY) * (viewScale / oldS - 1);
        }
        applyTransform();
    }

    const getDist   = t => Math.hypot(t[0].clientX-t[1].clientX, t[0].clientY-t[1].clientY);
    const getCenter = t => ({x:(t[0].clientX+t[1].clientX)/2, y:(t[0].clientY+t[1].clientY)/2});

    // === Canvas Init ===
    function initCanvas() {
        const mob = window.innerWidth <= 768;
        canvas.width = baseCanvas.width = mob ? 600 : 800;
        canvas.height = baseCanvas.height = mob ? 900 : 800;
        canvas.style.touchAction = 'none';
        canvas.style.cursor = 'crosshair';
        baseCtx.fillStyle = '#ffffff';
        baseCtx.fillRect(0, 0, baseCanvas.width, baseCanvas.height);
        shapes = []; selectedShape = null; currentPath = [];
        currentZoom = viewScale = 1.0; viewX = 0; viewY = 0;
        applyTransform();
        undoStack = []; saveUndoState();
        composite(); 
    }
    initCanvas();

    // === Composite: baseCanvas + 全シェイプ → メインキャンバス ===
    function composite(preview) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(baseCanvas, 0, 0);
        shapes.forEach(s => drawObj(ctx, s, s === selectedShape));
        if (preview) drawObj(ctx, preview, false);
    }

    function drawObj(tc, s, sel) {
        tc.save();
        tc.lineWidth = s.size;
        tc.strokeStyle = s.color;
        tc.lineCap = 'square';
        tc.lineJoin = 'miter';
        if (sel) { tc.shadowColor = 'rgba(255,255,255,0.9)'; tc.shadowBlur = 14; }

        if (s.type === 'pencil') {
            if (s.points.length < 2) { tc.restore(); return; }
            if (sel) tc.setLineDash([6, 4]);
            tc.beginPath();
            s.points.forEach((p, i) => i === 0 ? tc.moveTo(p.x, p.y) : tc.lineTo(p.x, p.y));
            tc.stroke();

        } else if (s.type === 'line') {
            if (sel) tc.setLineDash([8, 5]);
            tc.beginPath();
            tc.moveTo(s.x1, s.y1); tc.lineTo(s.x2, s.y2);
            tc.stroke();

        } else if (s.type === 'circle') {
            if (sel) tc.setLineDash([8, 5]);
            tc.beginPath();
            tc.ellipse(s.cx, s.cy, s.rx, s.ry, 0, 0, 2*Math.PI);
            tc.stroke();

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
    function saveUndoState() {
        undoStack.push({
            base: cloneID(baseCtx.getImageData(0, 0, baseCanvas.width, baseCanvas.height)),
            shapes: cloneShapes(shapes)
        });
        if (undoStack.length > MAX_UNDO) undoStack.shift();
        updateUndoBtn();
    }
    function undo() {
        if (undoStack.length <= 1) return;
        undoStack.pop();
        const p = undoStack[undoStack.length - 1];
        baseCtx.putImageData(cloneID(p.base), 0, 0);
        shapes = cloneShapes(p.shapes);
        selectedShape = null;
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
            } else if (s.type === 'circle') {
                const nd = Math.hypot((px-s.cx)/s.rx, (py-s.cy)/s.ry);
                if (Math.abs(nd - 1) <= thr / Math.min(s.rx, s.ry)) return s;
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
        if (s.type === 'circle') { s.cx+=dx; s.cy+=dy; }
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
        const cx = (e.touches && e.touches.length) ? e.touches[0].clientX : e.clientX;
        const cy = (e.touches && e.touches.length) ? e.touches[0].clientY : e.clientY;
        return { x:(cx-rect.left)*(canvas.width/rect.width), y:(cy-rect.top)*(canvas.height/rect.height) };
    }

    function startDraw(e) {
        const pos = getPos(e); lastPos = pos;
        
        // --- PC/マウス操作のパン開始 ---
        // ミドルクリックまたは移動ツールで背景をクリックした場合
        if (e.button !== undefined) {
             if (e.button === 1 || (currentTool === 'move' && e.button === 0)) {
                const hit = (e.button === 1) ? null : hitTest(pos.x, pos.y);
                if (!hit) {
                    isPanning = true;
                    lastMouseX = e.clientX;
                    lastMouseY = e.clientY;
                    canvas.style.cursor = 'move';
                    return;
                }
            }
        }

        if (currentTool === 'text') { addTextInput(pos.x, pos.y); return; }
        if (currentTool === 'move') {
            const hit = hitTest(pos.x, pos.y);
            selectedShape = hit || null; isDragging = !!hit;
            dragStartX = pos.x; dragStartY = pos.y;
            canvas.style.cursor = hit ? 'grabbing' : 'default';
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
                if (!rafPending) {
                    rafPending = true;
                    requestAnimationFrame(() => { composite(); rafPending = false; });
                }
            } else if (!isDragging) {
                canvas.style.cursor = hitTest(pos.x, pos.y) ? 'move' : 'default';
            }
            return;
        }
        if (!isDrawing) return;
        lastPos = pos;
        if (currentTool === 'pencil') {
            currentPath.push(pos);
            composite({ type:'pencil', points:currentPath, color:currentColor, size:currentSize });
        } else if (currentTool === 'line') {
            composite({ type:'line', x1:startX, y1:startY, x2:pos.x, y2:pos.y, color:currentColor, size:currentSize });
        } else if (currentTool === 'circle') {
            let rx = Math.abs(pos.x-startX), ry = Math.abs(pos.y-startY);
            if (e.shiftKey) { const r = Math.max(rx,ry); rx=r; ry=r; }
            if (rx>0&&ry>0) composite({ type:'circle', cx:startX, cy:startY, rx, ry, color:currentColor, size:currentSize });
        }
    }

    function stopDraw() {
        if (isPanning) {
            isPanning = false;
            canvas.style.cursor = (currentTool === 'move') ? 'default' : 'crosshair';
            return;
        }
        if (currentTool === 'move') {
            if (isDragging && selectedShape) saveUndoState();
            isDragging = false;
            canvas.style.cursor = selectedShape ? 'move' : 'default';
            return;
        }
        if (!isDrawing) return;
        isDrawing = false;
        if (currentTool === 'pencil') {
            if (currentPath.length >= 2) {
                shapes.push({ type:'pencil', points:[...currentPath], color:currentColor, size:currentSize });
                composite(); saveUndoState();
            }
            currentPath = [];
        } else if (currentTool === 'line') {
            if (lastPos.x !== startX || lastPos.y !== startY) {
                shapes.push({ type:'line', x1:startX, y1:startY, x2:lastPos.x, y2:lastPos.y, color:currentColor, size:currentSize });
                composite(); saveUndoState();
            }
        } else if (currentTool === 'circle') {
            const rx = Math.abs(lastPos.x-startX), ry = Math.abs(lastPos.y-startY);
            if (rx>0&&ry>0) {
                shapes.push({ type:'circle', cx:startX, cy:startY, rx, ry, color:currentColor, size:currentSize });
                composite(); saveUndoState();
            }
        }
    }

    // === Image / Save / Clear ===
    function handleImage(file) {
        if (!file || !file.type.startsWith('image/')) return;
        const el = document.getElementById('image-filename');
        if (el) el.textContent = file.name;
        const reader = new FileReader();
        reader.onload = ev => {
            const img = new Image();
            img.onload = () => {
                backgroundImage = img;
                const MAX = 3000;
                let w = img.width, h = img.height;
                if (w>MAX){h*=MAX/w;w=MAX;} if (h>MAX){w*=MAX/h;h=MAX;}
                canvas.width = baseCanvas.width = Math.round(w);
                canvas.height = baseCanvas.height = Math.round(h);
                baseCtx.drawImage(img, 0, 0, Math.round(w), Math.round(h));
                shapes = []; selectedShape = null; currentPath = [];
                // ビューをリセット
                viewScale = currentZoom = 1.0; viewX = 0; viewY = 0;
                velX = 0; velY = 0; stopMomentum(); // 慣性もリセット
                applyTransform();
                undoStack = []; saveUndoState();
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
        composite(); saveUndoState();
    }

    // === Event Listeners ===
    toolBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            toolBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            const map = {'btn-pencil':'pencil','btn-line':'line','btn-circle':'circle','btn-text':'text','btn-move':'move'};
            const lbl = {pencil:'Pencil',line:'Line',circle:'Circle',text:'Text',move:'Move'};
            currentTool = map[btn.id] || 'pencil';
            document.getElementById('tool-status').innerText = `Mode: ${lbl[currentTool]}`;
            if (currentTool === 'move') {
                selectedShape = null; composite();
                canvas.style.cursor = 'default';
                canvas.style.touchAction = 'none'; // 移動ツールも pan は不要
            } else {
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
    imageInput.addEventListener('change', e => handleImage(e.target.files[0]));
    btnSave.addEventListener('click', saveImage);
    btnClear.addEventListener('click', clearCanvas);
    if (btnUndo) btnUndo.addEventListener('click', undo);

    document.addEventListener('keydown', e => {
        if ((e.ctrlKey||e.metaKey) && e.key==='z') { e.preventDefault(); undo(); }
        if ((e.key==='Delete'||e.key==='Backspace') && selectedShape && currentTool==='move') {
            shapes = shapes.filter(s => s !== selectedShape);
            selectedShape = null; composite(); saveUndoState();
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
    canvas.addEventListener('mousemove', draw);
    window.addEventListener('mouseup', stopDraw);

    // --- Momentum Panning ---
    function stopMomentum() { if (momentumID) { cancelAnimationFrame(momentumID); momentumID = null; } }
    function startMomentum() {
        if (Math.abs(velX) < 0.1 && Math.abs(velY) < 0.1) {
            velX = 0; velY = 0; return;
        }
        viewX += velX;
        viewY += velY;
        applyTransform();
        velX *= 0.96; velY *= 0.96;
        momentumID = requestAnimationFrame(startMomentum);
    }

    function updateVelocity(dx, dy, dt) {
        const now = Date.now();
        moveHistory.push({ dx, dy, dt, t: now });
        // 直近100msのデータのみ維持
        moveHistory = moveHistory.filter(m => now - m.t < 100);
        if (moveHistory.length > 0) {
            const sumX = moveHistory.reduce((s, m) => s + m.dx, 0);
            const sumY = moveHistory.reduce((s, m) => s + m.dy, 0);
            const sumT = moveHistory.reduce((s, m) => s + m.dt, 0);
            if (sumT > 0) {
                // 1フレーム(約16.6ms)あたりの移動量に換算
                velX = (sumX / sumT) * 16.6;
                velY = (sumY / sumT) * 16.6;
            }
        }
    }

    // --- Touch（1本指=描画/移動/パン、2本指=ピンチズーム） ---
    canvas.addEventListener('touchstart', e => {
        stopMomentum();
        if (e.touches.length === 1) {
            const t = e.touches[0];
            lastTouchX = t.clientX; lastTouchY = t.clientY;
            lastTouchTime = Date.now();
            velX = 0; velY = 0; moveHistory = [];

            if (currentTool === 'move') {
                const pos = getPos(e);
                const hit = hitTest(pos.x, pos.y);
                if (hit) {
                    selectedShape = hit; isDragging = true;
                    dragStartX = pos.x; dragStartY = pos.y;
                    canvas.style.cursor = 'grabbing';
                    composite();
                    e.preventDefault();
                } else {
                    // 背景タッチならパンモードへ
                    selectedShape = null; isDragging = false;
                    isPanning = true;
                    composite();
                }
                return;
            }
            // 描画ツール
            e.preventDefault();
            startDraw(e);
        } else if (e.touches.length === 2) {
            e.preventDefault();
            lastPinchDistance = getDist(e.touches);
            lastPinchCenter   = getCenter(e.touches);
            if (isDrawing) stopDraw();
            isPanning = false; isDragging = false;
        }
    }, { passive:false });

    canvas.addEventListener('touchmove', e => {
        if (e.touches.length === 1) {
            const t = e.touches[0];
            const now = Date.now();
            const dt = now - lastTouchTime;
            const dx = t.clientX - lastTouchX;
            const dy = t.clientY - lastTouchY;

            if (currentTool === 'move') {
                if (isDragging && selectedShape) {
                    e.preventDefault();
                    draw(e); // 通常のシェイプ移動
                } else if (isPanning) {
                    e.preventDefault();
                    viewX += dx;
                    viewY += dy;
                    applyTransform();
                    updateVelocity(dx, dy, dt);
                }
                lastTouchX = t.clientX; lastTouchY = t.clientY;
                lastTouchTime = now;
                return;
            }

            e.preventDefault();
            draw(e);
            lastTouchX = t.clientX; lastTouchY = t.clientY;
        } else if (e.touches.length === 2 && lastPinchDistance !== null) {
            e.preventDefault();
            const d = getDist(e.touches), c = getCenter(e.touches);
            const scale = 1 + (d / lastPinchDistance - 1) * 0.25;
            
            // 重要: 2本指の中心点の動きをパンニング（移動）として反映
            viewX += c.x - lastPinchCenter.x;
            viewY += c.y - lastPinchCenter.y;
            
            setZoom(viewScale * scale, c.x, c.y);
            
            lastPinchCenter = c; lastPinchDistance = d;
        }
    }, { passive:false });

    canvas.addEventListener('touchend', e => {
        if (isPanning) {
            isPanning = false;
            startMomentum();
        }
        if (e.touches.length < 2) { lastPinchDistance = null; lastPinchCenter = null; }
        if (e.touches.length === 0) { isPanning = false; stopDraw(); }
    });

    // Wheel Zoom & Pan (2-finger touchpad support on PC)
    document.querySelector('.canvas-area').addEventListener('wheel', e => {
        e.preventDefault();
        if (e.ctrlKey) {
            // Zoom (Pinch or Ctrl+Wheel)
            const scale = e.deltaY > 0 ? 0.95 : 1.05;
            setZoom(viewScale * scale, e.clientX, e.clientY);
        } else {
            // Pan (Scroll or 2-finger swipe on trackpad)
            // deltaX/Y を使って表示位置を移動
            viewX -= e.deltaX;
            viewY -= e.deltaY;
            applyTransform();
        }
    }, { passive:false });

    // Mobile check
    function checkMobile() { document.body.classList.toggle('mobile-view', window.innerWidth <= 768); }
    window.addEventListener('resize', checkMobile);
    checkMobile();
});
