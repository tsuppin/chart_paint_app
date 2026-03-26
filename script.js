document.addEventListener('DOMContentLoaded', () => {
    // === DOM Elements ===
    const canvas = document.getElementById('main-canvas');
    const ctx = canvas.getContext('2d');
    const dropZone = document.getElementById('drop-zone');
    const imageInput = document.getElementById('image-upload');
    const btnUpload = document.getElementById('btn-upload');
    const btnSave = document.getElementById('btn-save');
    const btnClear = document.getElementById('btn-clear');
    const btnUndo = document.getElementById('btn-undo');
    
    // Tools & Colors
    const toolBtns = document.querySelectorAll('.tool-btn');
    const colorBtns = document.querySelectorAll('.color-btn');
    const brushSizeInput = document.getElementById('brush-size');
    const brushSizeVal = document.getElementById('brush-size-val');

    // === State ===
    let currentTool = 'pencil'; // 'pencil', 'line', 'circle', 'text'
    let currentColor = '#ff4d4d';
    let currentSize = 5;
    let isDrawing = false;
    let startX = 0;
    let startY = 0;
    let startScrollLeft = 0;
    let startScrollTop = 0;
    let snapshot = null; // Buffer to store previous canvas state for shape previews
    let undoStack = []; // アンドゥ用の履歴スタック
    const MAX_UNDO = 30; // 最大アンドゥ回数
    let backgroundImage = null; // To keep track of uploaded image
    let currentZoom = 1.0;
    let lastPinchDistance = null;
    let lastPinchCenter = null;

    // === Zoom Logic ===
    function setZoom(zoom) {
        const MIN_ZOOM = 0.1;
        const MAX_ZOOM = 5.0;
        currentZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom));
        canvas.style.width = `${canvas.width * currentZoom}px`;
        canvas.style.height = `${canvas.height * currentZoom}px`;
    }

    function getDistance(touches) {
        const dx = touches[0].clientX - touches[1].clientX;
        const dy = touches[0].clientY - touches[1].clientY;
        return Math.sqrt(dx * dx + dy * dy);
    }

    function getCenter(touches) {
        return {
            x: (touches[0].clientX + touches[1].clientX) / 2,
            y: (touches[0].clientY + touches[1].clientY) / 2
        };
    }

    // === Canvas Initialization ===
    function initCanvas() {
        const parent = canvas.parentElement;
        // Default size if no image. Make taller if mobile.
        const isMobile = window.innerWidth <= 768;
        canvas.width = 800;
        canvas.height = isMobile ? 1200 : 800;
        
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.lineWidth = currentSize;
        ctx.strokeStyle = currentColor;
        
        setZoom(1.0);
        
        // Initial Background
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        
        // 初期状態をアンドゥスタックに保存
        undoStack = [];
        saveUndoState();
    }

    initCanvas();

    // === Undo Logic ===
    function saveUndoState() {
        undoStack.push(ctx.getImageData(0, 0, canvas.width, canvas.height));
        if (undoStack.length > MAX_UNDO) {
            undoStack.shift();
        }
        updateUndoBtn();
    }

    function undo() {
        if (undoStack.length <= 1) return; // 最初の状態は消さない
        undoStack.pop(); // 現在の状態を破棄
        const prevState = undoStack[undoStack.length - 1];
        ctx.putImageData(prevState, 0, 0);
        updateUndoBtn();
    }

    function updateUndoBtn() {
        if (btnUndo) {
            btnUndo.disabled = undoStack.length <= 1;
        }
    }

    // === Text Tool Logic ===
    function drawText(text, x, y) {
        ctx.font = `${currentSize * 4}px Inter, sans-serif`;
        ctx.fillStyle = currentColor;
        const lines = text.split('\n');
        const lineHeight = currentSize * 4 * 1.2;
        lines.forEach((line, index) => {
            ctx.fillText(line, x, y + (index * lineHeight));
        });
    }

    function addTextInput(x, y) {
        // Remove any existing inputs
        const existingInput = document.getElementById('temp-text-input');
        if (existingInput) existingInput.remove();

        const input = document.createElement('textarea');
        input.id = 'temp-text-input';
        input.placeholder = '文字を入力\n(枠外クリックで確定)';
        input.rows = 1;

        // Use the container for absolute positioning
        const container = document.getElementById('canvas-container');

        // Calculate position in CSS pixels relative to the container
        const scaleX = canvas.offsetWidth / canvas.width;
        const scaleY = canvas.offsetHeight / canvas.height;

        const fontSize = currentSize * 4 * scaleX;
        input.style.position = 'absolute';
        input.style.left = `${x * scaleX}px`;
        input.style.top = `${y * scaleY}px`;
        input.style.font = `${fontSize}px Inter, sans-serif`;
        input.style.color = currentColor;
        input.style.background = 'rgba(30, 30, 35, 0.9)';
        input.style.border = '2px solid ' + currentColor;
        input.style.borderRadius = '4px';
        input.style.outline = 'none';
        input.style.zIndex = '1000';
        input.style.padding = '4px 8px';
        input.style.minWidth = '4em';
        input.style.resize = 'none';
        input.style.overflow = 'hidden';
        input.style.whiteSpace = 'pre';

        container.appendChild(input);

        // 文字幅測定用の hidden span
        const measurer = document.createElement('span');
        measurer.style.cssText =
            `position:absolute;visibility:hidden;white-space:pre;` +
            `font:${fontSize}px Inter,sans-serif;padding:4px 8px;left:-9999px;top:-9999px;`;
        document.body.appendChild(measurer);

        function resizeInput() {
            const lines = input.value ? input.value.split('\n') : ['\u00A0'];
            let maxW = 0;
            lines.forEach(line => {
                measurer.textContent = line || '\u00A0';
                maxW = Math.max(maxW, measurer.offsetWidth);
            });
            input.style.width = (maxW + 24) + 'px';
            input.style.height = 'auto';
            input.style.height = input.scrollHeight + 'px';
        }

        // Focus with a slight delay to ensure it's in the DOM
        setTimeout(() => {
            input.focus();
            resizeInput();
        }, 10);

        input.addEventListener('input', resizeInput);

        const handleFinish = () => {
            if (input.value && input.value !== input.placeholder) {
                drawText(input.value, x, y + (currentSize * 3));
                saveUndoState(); // テキスト描画後に保存
            }
            measurer.remove();
            input.remove();
        };

        input.addEventListener('keydown', (e) => {
            // Ctrl+Enter で確定
            if (e.key === 'Enter' && e.ctrlKey) {
                handleFinish();
            }
            if (e.key === 'Escape') {
                measurer.remove();
                input.remove();
            }
        });

        // Close on click outside (but not on the input itself)
        const clickOutside = (e) => {
            if (e.target !== input) {
                handleFinish();
                document.removeEventListener('mousedown', clickOutside);
            }
        };
        // Add listener after current event loop to avoid immediate trigger
        setTimeout(() => document.addEventListener('mousedown', clickOutside), 10);
    }

    // === Drawing Logic ===

    function getMousePos(e) {
        const rect = canvas.getBoundingClientRect();
        return {
            x: (e.clientX - rect.left) * (canvas.width / rect.width),
            y: (e.clientY - rect.top) * (canvas.height / rect.height)
        };
    }

    function startDraw(e) {
        // Handle input abstraction (Mouse/Touch)
        const isTouch = e.type.startsWith('touch');
        const eventObj = isTouch ? e.touches[0] : e;
        
        const pos = getMousePos(eventObj);
        
        if (currentTool === 'text') {
            addTextInput(pos.x, pos.y);
            return;
        }

        isDrawing = true;
        startX = pos.x;
        startY = pos.y;
        
        // Save current canvas state to snapshot for real-time previews
        snapshot = ctx.getImageData(0, 0, canvas.width, canvas.height);
        
        ctx.beginPath();
        ctx.lineWidth = currentSize;
        ctx.strokeStyle = currentColor;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        
        if (currentTool === 'pencil') {
            ctx.moveTo(startX, startY);
        }
    }

    function draw(e) {
        if (!isDrawing) return;
        
        const isTouch = e.type.startsWith('touch');
        const eventObj = isTouch ? e.touches[0] : e;

        const pos = getMousePos(eventObj);
        
        // Restore snapshot before drawing preview (for line/circle)
        if (currentTool !== 'pencil') {
            ctx.putImageData(snapshot, 0, 0);
        }

        ctx.lineWidth = currentSize;
        ctx.strokeStyle = currentColor;

        if (currentTool === 'pencil') {
            ctx.lineTo(pos.x, pos.y);
            ctx.stroke();
        } else if (currentTool === 'line') {
            ctx.beginPath();
            ctx.moveTo(startX, startY);
            ctx.lineTo(pos.x, pos.y);
            ctx.stroke();
        } else if (currentTool === 'circle') {
            let rX = Math.abs(pos.x - startX);
            let rY = Math.abs(pos.y - startY);
            // Shift キー押下時は正円にする
            if (e.shiftKey) {
                const r = Math.max(rX, rY);
                rX = r;
                rY = r;
            }
            if (rX === 0 || rY === 0) return;
            ctx.beginPath();
            ctx.ellipse(startX, startY, rX, rY, 0, 0, 2 * Math.PI);
            ctx.stroke();
        }
    }

    function stopDraw() {
        if (isDrawing) {
            ctx.closePath();
            isDrawing = false;
            // 描画完了後にアンドゥ用の状態を保存
            saveUndoState();
        }
    }

    // === Image Handling ===

    function handleImage(file) {
        if (!file || !file.type.startsWith('image/')) return;

        const reader = new FileReader();
        reader.onload = (e) => {
            const img = new Image();
            img.onload = () => {
                backgroundImage = img;
                
                // Keep original size so users can pan and draw in detail on mobile
                // Only scale down if the image is astronomically large (e.g. over 3000px)
                const MAX_DIM = 3000;
                
                let width = img.width;
                let height = img.height;

                if (width > MAX_DIM) {
                    height *= MAX_DIM / width;
                    width = MAX_DIM;
                }
                if (height > MAX_DIM) {
                    width *= MAX_DIM / height;
                    height = MAX_DIM;
                }

                canvas.width = img.width; // Use full size for quality
                canvas.height = img.height;
                
                setZoom(1.0);
                
                ctx.drawImage(img, 0, 0);
                
                // 画像読み込み後にアンドゥスタックをリセットし、画像描画状態を初期スナップショットとして保存
                undoStack = [];
                saveUndoState();
                
                // Update UI
                dropZone.classList.add('hidden');
                
                // Reset ctx properties since canvas resize clears them
                ctx.lineCap = 'round';
                ctx.lineJoin = 'round';
            };
            img.src = e.target.result;
        };
        reader.readAsDataURL(file);
    }

    function saveImage() {
        const link = document.createElement('a');
        link.download = `paint-edit-${Date.now()}.png`;
        link.href = canvas.toDataURL();
        link.click();
    }

    function clearCanvas() {
        if (confirm('キャンバスをクリアしますか？')) {
            if (backgroundImage) {
                ctx.drawImage(backgroundImage, 0, 0);
            } else {
                ctx.fillStyle = '#ffffff';
                ctx.fillRect(0, 0, canvas.width, canvas.height);
            }
        }
    }

    // === Event Listeners ===

    // Tools
    toolBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            toolBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            
            const toolLabels = {
                'btn-pencil': 'Pencil',
                'btn-line': 'Line',
                'btn-circle': 'Circle',
                'btn-text': 'Text'
            };

            if (btn.id === 'btn-pencil') currentTool = 'pencil';
            if (btn.id === 'btn-line') currentTool = 'line';
            if (btn.id === 'btn-circle') currentTool = 'circle';
            if (btn.id === 'btn-text') currentTool = 'text';

            document.getElementById('tool-status').innerText = `Mode: ${toolLabels[btn.id]}`;

            canvas.style.touchAction = 'none';
            canvas.style.cursor = 'crosshair';
        });
    });

    // Colors
    colorBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            colorBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentColor = btn.dataset.color;
        });
    });

    // Brush Size
    brushSizeInput.addEventListener('input', (e) => {
        currentSize = e.target.value;
        brushSizeVal.innerText = `${currentSize}px`;
    });

    // Upload / Save / Clear
    btnUpload.addEventListener('click', () => imageInput.click());
    imageInput.addEventListener('change', (e) => handleImage(e.target.files[0]));

    btnSave.addEventListener('click', saveImage);
    btnClear.addEventListener('click', clearCanvas);
    if (btnUndo) btnUndo.addEventListener('click', undo);

    // Ctrl+Z でアンドゥ
    document.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
            e.preventDefault();
            undo();
        }
    });

    // Drag & Drop
    window.addEventListener('dragover', (e) => {
        e.preventDefault();
        if (!backgroundImage) dropZone.classList.remove('hidden');
    });

    window.addEventListener('dragleave', (e) => {
        if (!backgroundImage) dropZone.classList.add('hidden');
    });

    window.addEventListener('drop', (e) => {
        e.preventDefault();
        handleImage(e.dataTransfer.files[0]);
    });

    // Click dropzone to upload if empty
    dropZone.addEventListener('click', () => {
        if (!backgroundImage) imageInput.click();
    });

    canvas.addEventListener('mousedown', startDraw);
    canvas.addEventListener('mousemove', draw);
    window.addEventListener('mouseup', stopDraw);

    // Unified Touch support
    canvas.addEventListener('touchstart', (e) => {
        if (e.touches.length === 1) {
            e.preventDefault();
            startDraw(e);
        } else if (e.touches.length === 2) {
            e.preventDefault();
            lastPinchDistance = getDistance(e.touches);
            lastPinchCenter = getCenter(e.touches);
            if (isDrawing) stopDraw();
        }
    }, { passive: false });

    canvas.addEventListener('touchmove', (e) => {
        if (e.touches.length === 1) {
            e.preventDefault();
            draw(e);
        } else if (e.touches.length === 2 && lastPinchDistance !== null) {
            e.preventDefault();
            
            const currentDistance = getDistance(e.touches);
            const currentCenter = getCenter(e.touches);
            
            // Calculate deltas
            const rawScaleDiff = currentDistance / lastPinchDistance;
            const scaleDiff = 1 + (rawScaleDiff - 1.0) * 0.15; // スピードをもっと緩やかにする
            const dx = currentCenter.x - lastPinchCenter.x;
            const dy = currentCenter.y - lastPinchCenter.y;
            
            const canvasArea = document.querySelector('.canvas-area');
            
            // First adjust pan
            canvasArea.scrollLeft -= dx;
            canvasArea.scrollTop -= dy;
            
            // Then adjust zoom if changed significantly
            if (Math.abs(scaleDiff - 1.0) > 0.002) {
                setZoom(currentZoom * scaleDiff);
            }
            
            // Update tracking
            lastPinchCenter = currentCenter;
            lastPinchDistance = currentDistance;
        }
    }, { passive: false });

    canvas.addEventListener('touchend', (e) => {
        if (e.touches.length < 2) {
            lastPinchDistance = null;
            lastPinchCenter = null;
        }
        if (e.touches.length === 0) {
            stopDraw();
        }
    });

    // Desktop pinch to zoom equivalent (Ctrl + Wheel)
    const canvasArea = document.querySelector('.canvas-area');
    canvasArea.addEventListener('wheel', (e) => {
        if (e.ctrlKey) {
            e.preventDefault();
            const zoomChange = e.deltaY > 0 ? 0.99 : 1.01; // 縮尺スピードをもっと緩やかに
            setZoom(currentZoom * zoomChange);
        }
    }, { passive: false });

    // Mobile View Toggle
    function checkMobile() {
        if (window.innerWidth <= 768) {
            document.body.classList.add('mobile-view');
        } else {
            document.body.classList.remove('mobile-view');
        }
    }
    window.addEventListener('resize', checkMobile);
    checkMobile();
});
