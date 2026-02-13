    // --- 核心数据结构 ---
    let bData = [];
    
    // --- 运行时状态 ---
    let activeGroupIdx = -1;  // 当前操作的分组索引
    let activeLinkIdx = -1;   // 当前操作的链接索引 (如果是分组操作则为-1)
    let contextTargetType = ''; // 'group' 或 'link'
    let closeTimer = null;
    let showTimer = null; // 用于控制延迟显示的计时器
    let isDragging = false; // 拖拽状态锁
    let isMenuOpen = false;   // 阻止弹窗关闭的关键锁
    
    let popSortable = null;

    // --- DOM 引用 ---
    const els = {
        popover: document.getElementById('popover'),
        mainGrid: document.getElementById('mainGrid'),
        zoomWrapper: document.getElementById('zoomWrapper'),
        contextMenu: document.getElementById('contextMenu'),
        searchInput: document.getElementById('searchInput'),
        searchHints: document.getElementById('searchHints'),
        // searchSelect: document.getElementById('searchSelect'),
        toast: document.getElementById('toast')
    };
    
    let mainRenderQueued = false;
    function scheduleRenderMain() {
        if (mainRenderQueued) return;
        mainRenderQueued = true;
        requestAnimationFrame(() => {
            mainRenderQueued = false;
            renderMain();
        });
    }
    
    let saveTimer = 0;
    function scheduleSaveData() {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
            saveData();
        });
    }

    
    // --- 初始化 ---
    window.onload = async () => {
        // 1. 尝试加载背景图
        tryLoadBackground();
        
        // 2. 核心数据加载逻辑：JSON > HTML > LocalStorage
        await initDataPipeline();

        // 3. 渲染与缩放
        renderMain();
        handleZoom();
        
        // 4. 绑定全局事件
        let zoomRAF = 0;
        window.addEventListener('resize', () => {
            if (zoomRAF) cancelAnimationFrame(zoomRAF);
            zoomRAF = requestAnimationFrame(() => {
                zoomRAF = 0;
                handleZoom();
            });
        });

        // 1. Web 环境监听 (LocalStorage 变化)
        window.addEventListener('storage', async (e) => {
            if (e.key === 'nav_elite_data') {
                const newData = await Store.get('nav_elite_data');
                if (newData) {
                    bData = newData;
                    scheduleRenderMain();
                }
            }
        });
        // 2. Chrome 扩展环境监听 (Storage 变化，来自 Popup 的数据更新)
        if (typeof chrome !== 'undefined' && chrome.storage) {
            chrome.storage.onChanged.addListener((changes, area) => {
                if (area === 'local' && changes.nav_elite_data) {
                    bData = changes.nav_elite_data.newValue || [];
                    scheduleRenderMain();
                    // showToast("同步成功！");
                }
            });
        }
        document.addEventListener('click', (e) => {
            // 点击任意处关闭右键菜单
            if (!els.contextMenu.contains(e.target)) {
                els.contextMenu.style.display = 'none';
                isMenuOpen = false;
                
                // 如果点击的也不是popover，也不是分组图标，则关闭popover
                if (!els.popover.contains(e.target) && !e.target.closest('.group-node')) {
                    hidePopoverNow();
                }
            }
        });
        
        // 拖拽初始化
        new Sortable(els.mainGrid, {
            animation: 200,
            ghostClass: 'sortable-ghost',
            draggable: ".group-node", // 明确指定可拖拽的元素类名
            delay: 200, // 必须按住 200ms 才开始拖拽
            delayOnTouchOnly: true, // 只在触摸屏上启用延迟，不影响鼠标手感
            touchStartThreshold: 5, // 允许 5px 的手指抖动，防止轻微晃动导致点击失效
            swapThreshold: 0.65, // 提高交换阈值，让排序手感更稳重
            onChoose: () => { 
                // 在鼠标按下的一瞬间 (onChoose)，就清除显示计时
                clearTimeout(showTimer); 
            },
            // 开始拖拽时清除计时器并上锁
            onStart: () => {
                isDragging = true;
                clearTimeout(showTimer); 
                hidePopoverNow(); // 如果弹窗已经开了，强制关闭
            },
            // 拖拽结束时解锁
            onEnd: (evt) => {
                // 拖拽结束后，稍等一下再解锁 isDragging
                // 这样可以防止松开鼠标的那一瞬间误触发 onclick
                setTimeout(() => { 
                    isDragging = false; 
                    updateOrder(); // 调用更新排序逻辑
                }, 100);
            }
        });
        bindEventListeners();
    };
    
    function bindEventListeners() {
        // 全局委托：处理搜索建议点击
        els.searchHints.addEventListener('click', (e) => {
            const item = e.target.closest('.menu-item');
            if (item && item.dataset.url) {
                const url = item.dataset.url;
                if (url.startsWith('chrome://') || url.startsWith('edge://')) {
                    // 使用扩展专属 API 打开标签页
                    if (typeof chrome !== 'undefined' && chrome.tabs) {
                        chrome.tabs.create({ url: url });
                    } else {
                        alert("由于浏览器安全限制，请手动复制地址并在地址栏打开：" + url); // 如果是在浏览器直接双击 HTML 打开的，这里会作为保底提示
                    }
                } else {
                    window.open(url, '_blank'); // 普通网址依然使用 window.open
                }
                els.searchHints.style.display = 'none';
            }
        });
        
        // 全局委托：处理弹窗(Popover)内的图标
        const popGrid = document.getElementById('popGrid');
        if (popGrid) {
            // 点击：打开网址
            popGrid.addEventListener('click', (e) => {
                const linkEl = e.target.closest('.pop-link');
                if (linkEl && linkEl.dataset.url) {
                    // 阻止事件冒泡，防止触发多次
                    e.preventDefault();
                    e.stopPropagation();
                    
                    // 检测是否为 Chrome 特权协议
                    const url = linkEl.dataset.url;
                    if (url.startsWith('chrome://') || url.startsWith('edge://')) {
                        // 使用扩展专属 API 打开标签页
                        if (typeof chrome !== 'undefined' && chrome.tabs) {
                            chrome.tabs.create({ url: url });
                        } else {
                            alert("由于浏览器安全限制，请手动复制地址并在地址栏打开：" + url); // 如果是在浏览器直接双击 HTML 打开的，这里会作为保底提示
                        }
                    } else {
                        window.open(url, '_blank'); // 普通网址依然使用 window.open
                    }
                }
            });
        
            // 右键：弹出菜单
            popGrid.addEventListener('contextmenu', (e) => {
                const linkEl = e.target.closest('.pop-link');
                if (!linkEl|| linkEl.dataset.linkIdx === undefined) return; // 如果没点到图标，或者点到的是没有索引的空区域，直接返回
                // 阻止事件冒泡，防止触发多次
                e.preventDefault();
                e.stopPropagation();
                
                openContextMenu(e, 'link', Number(linkEl.dataset.linkIdx));
            });
        }
        
        // 全局委托：处理所有 data-action 按钮
        document.addEventListener('click', (e) => {
            const action = e.target.getAttribute('data-action');
            if (!action) return;
            
            switch(action) {
                // 右键菜单动作
                case 'edit':
                case 'icon':
                case 'delete':
                    handleMenuAction(action);
                    break;
                
                // 工具按钮动作
                case 'import-bookmarks':
                    document.getElementById('fileInput').click();
                    break;
                case 'export-config':
                    exportConfig();
                    break;
                case 'import-config':
                    document.getElementById('configInput').click();
                    break;
                case 'change-bg':
                    document.getElementById('bgInput').click();
                    break;
                case 'add-link':
                    openAddLinkPopup();
                    break;
                case 'repair-all':
                    // 触发全站修复函数
                    repairAllIcons();
                    break;
                
                // 添加链接弹窗按钮
                case 'cancel-add-link':
                    closeAddLinkPopup();
                    break;
                case 'confirm-add-link':
                    addLinkToGroup();
                    break;
                
                // 默认情况（可选）
                default:
                    console.warn('未处理的 action:', action);
            }
        });
        
        // === mainGrid 委托：点击 / 右键 / 悬浮 ===
        let hoverIdx = -1;
        els.mainGrid.addEventListener('click', (e) => {
            const node = e.target.closest('.group-node');
            if (!node) return;

            clearTimeout(showTimer);
            if (isDragging || isMenuOpen) return;

            const idx = Number(node.dataset.idx);
            if (els.popover.style.display === 'block' && activeGroupIdx === idx) {
                hidePopoverNow();
            } else {
                showPopover({ currentTarget: node }, idx);
            }
        });
        els.mainGrid.addEventListener('contextmenu', (e) => {
            const node = e.target.closest('.group-node');
            if (!node) return;
            e.preventDefault();
            const idx = Number(node.dataset.idx);
            openContextMenu(e, 'group', idx);
        });
        // 用 pointerover/out 代替 mouseenter/leave（可冒泡，适合委托）
        els.mainGrid.addEventListener('pointerover', (e) => {
            const node = e.target.closest('.group-node');
            if (!node) return;
            if (isDragging || isMenuOpen) return;

            const idx = Number(node.dataset.idx);
            if (hoverIdx === idx) return;
            hoverIdx = idx;

            clearTimeout(closeTimer);
            clearTimeout(showTimer);

            showTimer = setTimeout(() => {
                if (!isDragging && !isMenuOpen) {
                    showPopover({ currentTarget: node }, idx);
                }
            }, 500);
        });
        els.mainGrid.addEventListener('pointerout', (e) => {
            const node = e.target.closest('.group-node');
            if (!node) return;

            // 真正离开这个 node（不是离开到 node 内部子元素）
            if (node.contains(e.relatedTarget)) return;

            hoverIdx = -1;
            clearTimeout(showTimer);
            tryHidePopover();
        });
        
        // mainGrid: 统一处理预览图标加载失败
        els.mainGrid.addEventListener('error', (e) => {
            const img = e.target;
            if (!(img instanceof HTMLImageElement)) return;
            if (!img.classList.contains('preview-icon')) return;

            img.src = 'data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 24 24%22 fill=%22%23ddd%22><circle cx=%2212%22 cy=%2212%22 r=%2210%22/></svg>';
        }, true);
        // popGrid: 统一处理弹窗图标失败 -> 回退 Google favicon
        popGrid.addEventListener('error', (e) => {
            const img = e.target;
            if (!(img instanceof HTMLImageElement)) return;
            if (!img.classList.contains('pop-icon')) return;

            const linkEl = img.closest('.pop-link');
            if (!linkEl) return;
            const url = linkEl.dataset.url;
            if (!url) return;

            try {
                const u = new URL(url);
                img.src = `https://www.google.com/s2/favicons?sz=64&domain=${u.hostname}`;
            } catch {
                img.src = 'data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 24 24%22 fill=%22%23ddd%22><circle cx=%2212%22 cy=%2212%22 r=%2210%22/></svg>';
            }
        }, true);
    }

    // --- 1. 自适应缩放逻辑 (Point 1) ---
    function handleZoom() {
        // 基准宽度 1200px (对应8列 + 间隙)
        const baseW = 1200; 
        const winW = window.innerWidth;
        const winH = window.innerHeight;
        
        // 计算宽缩放比和高缩放比
        // 预留一些边距 (width * 0.9)
        const scaleX = (winW * 0.95) / baseW;
        // 假设高度基准是 800px
        const scaleY = (winH * 0.9) / 800; 
        
        // 取较小值以保证完全可见
        let scale = Math.min(scaleX, scaleY);
        // 限制缩放范围，防止过大或过小
        scale = Math.max(0.5, Math.min(scale, 1.2));
        
        els.zoomWrapper.style.transform = `scale(${scale})`;
    }

    // --- 渲染逻辑 ---
    function renderMain() {
        els.mainGrid.textContent = '';
        const frag = document.createDocumentFragment();
        bData.forEach((g, idx) => {
            const node = document.createElement('div');
            // 确保类名包含 group-node 供 Sortable 识别
            node.className = 'node-item group-node';
            node.dataset.idx = idx; // 增加索引标记
            
            // 图标渲染：自定义图 or 九宫格
            let iconContent;
            if (g.customIcon) {
                iconContent = `<img src="${g.customIcon}" loading="lazy" decoding="async">`;
            } else {
                // 提取前 9 个图标生成九宫格预览
                const imgs = g.links.slice(0, 9).map(l => `<img src="${l.icon}" class="preview-icon" loading="lazy" decoding="async">`).join('');
                iconContent = `<div class="preview-grid">${imgs}</div>`;
            }

            node.innerHTML = `
                <div class="icon-sphere" style="pointer-events: none;">${iconContent}</div>
                <div class="label-text" style="pointer-events: none;">${g.group}</div>
            `;
            frag.appendChild(node);
            // 注意：上面给内部元素加了 pointer-events: none，是为了让点击事件穿透到 node 节点本身，
            // 这样可以极大提高拖拽和点击的稳定性。
        });
        els.mainGrid.appendChild(frag);
    }

    // --- 2. 弹窗逻辑 (Point 2 & 3) ---
    function showPopover(e, idx) {
        if (isDragging || isMenuOpen) return; // 如果正在拖拽或右键菜单已打开，严禁弹窗
        
        activeGroupIdx = idx;
        const g = bData[idx];
        document.getElementById('popTitle').innerText = g.group; // 更新弹窗标题为当前分组的名称
        // 兼容性处理：如果是从 onclick 传进来的，目标是 e.currentTarget
        // 如果是从 setTimeout 传进来的，你之前已经处理了对象包装
        const targetNode = e.currentTarget; 
        if (!targetNode) return;
        
        // 渲染弹窗内容
        popGrid.innerHTML = g.links.map((l, lIdx) => `
            <div class="pop-link"
                 data-link-idx="${lIdx}"
                 data-url="${l.url}">
                <div class="pop-icon-box">
                    <img src="${l.icon}" class="pop-icon">
                </div>
                <div class="pop-text" title="${l.name}">${l.name}</div>
            </div>
        `).join('');

        // 初始化分组内拖拽
        new Sortable(document.getElementById('popGrid'), {
            animation: 150,
            ghostClass: 'sortable-ghost',
            draggable: ".pop-link",     // 明确指定只有链接图标可拖拽
            delay: 200,                // 必须按住 200ms 才开始拖拽
            delayOnTouchOnly: true,    // 只在触摸屏上启用延迟，不影响鼠标手感
            touchStartThreshold: 5,    // 允许 5px 的手指抖动，防止轻微晃动导致点击失效
            swapThreshold: 0.65, // 提高交换阈值，让排序手感更稳重
            onEnd: (evt) => {
                const g = bData[activeGroupIdx];
                const items = Array.from(evt.from.children); // 获取拖拽后的实际 DOM 列表
                
                // 1. 根据当前 DOM 顺序重新构建数组
                const newLinks = items.map(item => {
                    const linkIdx = parseInt(item.dataset.linkIdx);
                    return g.links[linkIdx];
                });
                
                // 2. 更新内存数据
                g.links = newLinks;
                
                // 3. 核心组合：保存并“刷新”
                scheduleSaveData();      // 写入持久化存储
                refreshPopover(); // 关键！重新渲染弹窗内容，更新所有 dataset-link-idx
                scheduleRenderMain();    // 也要更新主界面的九宫格预览
            }
        });

        // 计算位置
        const rect = targetNode.getBoundingClientRect(); // 使用 targetNode
        els.popover.style.display = 'block';
        els.popover.style.opacity = '0';
        
        // 确保弹窗已渲染以获取尺寸
        requestAnimationFrame(() => {
            const padding = 16;
            const pW = els.popover.offsetWidth;
            const pH = els.popover.offsetHeight;
            // 理想居中
            let left = rect.left + rect.width / 2 - pW / 2;
            let top  = rect.bottom + 15;

            // 横向夹紧（最终）
            left = Math.max(
                padding,
                Math.min(left, window.innerWidth - pW - padding)
            );
            // 纵向：下方不够则放上方
            if (top + pH + padding > window.innerHeight) {
                top = rect.top - pH - 15;
            }
            // ★ 纵向最终夹紧（你之前缺的关键一步）
            top = Math.max(
                padding,
                Math.min(top, window.innerHeight - pH - padding)
            );

            els.popover.style.left = `${left}px`;
            els.popover.style.top  = `${top}px`;
            els.popover.style.opacity = '1';
        });
    }

    function tryHidePopover() {
        // Point 3: 如果菜单打开，绝对不隐藏
        if (isMenuOpen) return;
        
        closeTimer = setTimeout(() => {
            els.popover.style.opacity = '0';
            setTimeout(() => {
                // 双重检查，防止在淡出动画时又移入
                if (els.popover.style.opacity === '0') els.popover.style.display = 'none';
            }, 200);
        }, 300);
    }
    
    function openAddLinkPopup() {
        const pop = document.getElementById('addLinkPopover');
        pop.style.display = 'block';

        // 填充分组下拉框
        const sel = document.getElementById('groupSelect');
        const newGroupNameInput = document.getElementById('newGroupName'); // 提取引用
        sel.innerHTML = '';
        
        // 1. 填充分组
        bData.forEach((g, idx) => {
            const opt = document.createElement('option');
            opt.value = idx;
            opt.textContent = g.group;
            sel.appendChild(opt);
        });
        
        // 添加“新建分组”选项
        const newOpt = document.createElement('option');
        newOpt.value = 'new';
        newOpt.textContent = '新建分组';
        sel.appendChild(newOpt);
        
        // 定义控制逻辑
        const toggleNewGroupInput = () => {
            if (sel.value === 'new') {
                newGroupNameInput.style.display = 'block';
                newGroupNameInput.focus(); // 自动聚焦，方便直接输入
            } else {
                newGroupNameInput.style.display = 'none';
            }
        };
        
        // 绑定事件
        sel.onchange = toggleNewGroupInput;
        
        // 初始化执行一次检查
        // 如果 bData 为空，此时 sel.value 必然是 'new'，手动触发显示
        toggleNewGroupInput();
    }

    function closeAddLinkPopup() {
        const pop = document.getElementById('addLinkPopover');
        pop.style.display = 'none';
        document.getElementById('newLinkName').value = '';
        document.getElementById('newLinkURL').value = '';
        document.getElementById('newGroupName').value = '';
    }
    
    function addLinkToGroup() {
        const name = document.getElementById('newLinkName').value.trim();
        const url = document.getElementById('newLinkURL').value.trim();
        const groupSel = document.getElementById('groupSelect').value;
        const newGroupName = document.getElementById('newGroupName').value.trim();

        if(!name || !url) { showToast("名称和网址不能为空"); return; }

        let groupIdx;
        if(groupSel === 'new') {
            if(!newGroupName) { showToast("请填写新分组名称"); return; }
            const newGroup = { group: newGroupName, links: [], customIcon: null };
            bData.push(newGroup);
            groupIdx = bData.length - 1;
        } else {
            groupIdx = parseInt(groupSel);
        }

        // 添加链接
        let icon;
        try { 
            const u = new URL(url);
            icon = `https://www.google.com/s2/favicons?sz=64&domain=${u.hostname}`;
        } catch(e) { icon = ''; }

        bData[groupIdx].links.push({ name, url, icon });

        scheduleSaveData();
        if(activeGroupIdx === groupIdx) refreshPopover(); // 如果弹窗打开，刷新内容
        scheduleRenderMain();

        showToast("添加成功");
        closeAddLinkPopup();
    }
    
    function hidePopoverNow() {
        clearTimeout(closeTimer);
        els.popover.style.display = 'none';
        els.popover.style.opacity = '0';
    }

    els.popover.onmouseenter = () => clearTimeout(closeTimer);
    els.popover.onmouseleave = tryHidePopover;

    // --- 3. 统一右键菜单逻辑 (Point 3) ---
    function openContextMenu(e, type, idx) {
        e.preventDefault();
        e.stopPropagation();
        
        isMenuOpen = true; // 锁定弹窗不消失
        contextTargetType = type; // 'group' or 'link'
        
        if (type === 'group') {
            activeGroupIdx = idx;
            activeLinkIdx = -1;
        } else {
            // 在弹窗里的link被点击，activeGroupIdx 已经在 showPopover 时设置好了
            activeLinkIdx = idx;
        }
        
        // 菜单定位防溢出
        const menu = els.contextMenu;
        menu.style.display = 'block';
        let x = e.clientX;
        let y = e.clientY;
        
        if (x + 160 > window.innerWidth) x -= 160;
        if (y + 120 > window.innerHeight) y -= 120;
        
        menu.style.left = `${x}px`;
        menu.style.top = `${y}px`;
    }

    function handleMenuAction(action) {
        els.contextMenu.style.display = 'none';
        isMenuOpen = false;
    
        if (action === 'edit') {
            if (contextTargetType === 'group') {
                // 分组只需修改名称
                const oldName = bData[activeGroupIdx].group;
                const newGroupName = prompt("请输入新的分组名称:", oldName);
                if (newGroupName && newGroupName.trim() !== "") {
                    bData[activeGroupIdx].group = newGroupName.trim();
                    scheduleSaveData();
                    scheduleRenderMain();
                }
            } else {
                // 链接修改：名称 + 网址
                const link = bData[activeGroupIdx].links[activeLinkIdx];
            
                // 第一步：修改名称
                const newName = prompt("1/2 修改名称:", link.name);
                if (newName !== null) { // 用户没点取消
                
                    // 第二步：修改网址
                    const newUrl = prompt("2/2 修改网址:", link.url);
                    if (newUrl !== null) { // 用户没点取消
                    
                        // 更新数据
                        link.name = newName.trim() || link.name;
                        link.url = newUrl.trim() || link.url;
                    
                        // 核心：如果网址变了，尝试自动更新图标 (可选，建议保留)
                        if (newUrl.trim() !== "") {
                            try {
                                const u = new URL(link.url);
                                // 只有当用户没有自定义过本地图标时，才自动抓取 Google Favicon
                                if (!link.icon.startsWith('data:image')) {
                                    link.icon = `https://www.google.com/s2/favicons?sz=64&domain=${u.hostname}`;
                                }
                            } catch(e) { console.warn("网址格式不正确，无法自动更新图标"); }
                        }

                        scheduleSaveData();       // 保存到本地缓存
                        refreshPopover(); // 刷新当前弹窗内容
                        showToast("信息修改成功");
                    }
                }
            }
        }
        else if (action === 'icon') {
            // 触发隐藏的文件输入框
            document.getElementById('iconInput').click();
        }
        else if (action === 'delete') {
            if (confirm("确定删除吗？")) {
                if (contextTargetType === 'group') {
                    bData.splice(activeGroupIdx, 1);
                    hidePopoverNow();
                    scheduleSaveData();
                    scheduleRenderMain();
                } else {
                    bData[activeGroupIdx].links.splice(activeLinkIdx, 1);
                    scheduleSaveData();
                    refreshPopover();
                    scheduleRenderMain();
                }
            }
        }
    }

    // 处理图标上传
    document.getElementById('iconInput').onchange = (e) => {
        if (!e.target.files.length) return;
        const file = e.target.files[0];
        const maxSize = 30 * 1024; // 图标 30KB 限制
        // --- 检查图标文件大小 ---
        if (file.size > maxSize) {
            alert(`图片太大啦！当前大小：${(file.size / 1024).toFixed(1)}KB，请上传小于 30KB 的图片。`);
            e.target.value = ''; // 清空选择
            return;
        }
        const reader = new FileReader();
        reader.onload = (ev) => {
            const res = ev.target.result;
            // 这里的 res 是 Base64 字符串
            if (contextTargetType === 'group') {
                bData[activeGroupIdx].customIcon = res;
                scheduleSaveData();
                scheduleRenderMain();
            } else {
                bData[activeGroupIdx].links[activeLinkIdx].icon = res;
                scheduleSaveData();
                refreshPopover();
                scheduleRenderMain();
            }
            e.target.value = ''; // 重置以便重复触发
            showToast("图标设置成功");
        };
        reader.readAsDataURL(file);
    };

    function refreshPopover() {
        // 重新渲染当前打开的弹窗
        if (activeGroupIdx > -1) {
            // 模拟一次事件对象来调用 showPopover 比较麻烦，
            // 直接更新内容更高效
            const g = bData[activeGroupIdx];
            const popGrid = document.getElementById('popGrid');
            popGrid.innerHTML = g.links.map((l, lIdx) => `
                <div class="pop-link"
                     data-link-idx="${lIdx}"
                     data-url="${l.url}">
                    <div class="pop-icon-box">
                        <img src="${l.icon}" class="pop-icon">
                    </div>
                    <div class="pop-text">${l.name}</div>
                </div>
            `).join('');

            // 初始化拖拽
            if (popSortable) {
                popSortable.destroy();
                popSortable = null;
            }
            popSortable = new Sortable(popGrid, {
                animation: 150,
                ghostClass: 'sortable-ghost',
                draggable: ".pop-link",     // 明确指定只有链接图标可拖拽
                delay: 200,                // 必须按住 200ms 才开始拖拽
                delayOnTouchOnly: true,    // 只在触摸屏上启用延迟，不影响鼠标手感
                touchStartThreshold: 5,    // 允许 5px 的手指抖动，防止轻微晃动导致点击失效
                swapThreshold: 0.65, // 提高交换阈值，让排序手感更稳重
                onEnd: (evt) => {
                    const newLinks = [];
                    const items = evt.from.children;
                    for (let i = 0; i < items.length; i++) {
                        const name = items[i].querySelector('.pop-text').innerText;
                        const link = g.links.find(l => l.name === name);
                        if (link) newLinks.push(link);
                    }
                    g.links = newLinks;
                    scheduleSaveData();
                }
            });
        }
    }

    // --- 4. 快速查找（本地匹配 + 默认搜索） ---
    // els.searchSelect.onchange = () => Store.set('nav_pro_search', els.searchSelect.value);
    
    els.searchInput.oninput = (e) => {
        const kw = e.target.value.trim().toLowerCase();
        if (!kw) { els.searchHints.style.display = 'none'; return; }
        
        let res = [];
        bData.forEach(g => g.links.forEach(l => { 
            if (l.name.toLowerCase().includes(kw) || l.url.includes(kw)) res.push(l); 
        }));
        
        if (res.length > 0) {
            els.searchHints.innerHTML = res.slice(0, 8).map(l => `
                <div class="menu-item" data-url="${l.url}" style="display:flex; align-items:center; padding:8px; cursor:pointer; border-radius:8px;">
                    <img src="${l.icon}" style="width:24px; height:24px; border-radius:50%; margin-right:10px;">
                    <span style="font-size:14px; color:#333; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${l.name}</span>
                </div>
            `).join('');
            els.searchHints.style.display = 'grid';
        } else {
            els.searchHints.style.display = 'none';
        }
    };
    
    els.searchInput.onkeydown = (e) => {
        if (e.key === 'Enter') {
            if (els.searchInput.value) {
                const q = els.searchInput.value.trim();
                if (!q) return;
                if (chrome?.search?.query) {
                    chrome.search.query({ text: q, disposition: 'NEW_TAB' });
                } else {
                    window.open('https://www.google.com/search?q=' + encodeURIComponent(q), '_blank');
                }
                // window.open(els.searchSelect.value + encodeURIComponent(els.searchInput.value), '_blank');
            }
            els.searchHints.style.display = 'none';
        }
    };

    // --- 5. 书签导入 (Point 5 - 重写) ---
    // 递归遍历 DOM 树提取链接
    function traverseBookmarks(element, currentGroup, results) {
        const children = Array.from(element.children);
        
        children.forEach(child => {
            const tagName = child.tagName.toUpperCase();
            
            if (tagName === 'H3') {
                // 发现新分组
                currentGroup = {
                    group: child.textContent.trim() || '未命名',
                    links: [],
                    customIcon: null
                };
                results.push(currentGroup);
            } 
            else if (tagName === 'A') {
                // 发现链接
                if (currentGroup) {
                    let icon;
                    try {
                        const u = new URL(child.href);
                        icon = `https://www.google.com/s2/favicons?sz=64&domain=${u.hostname}`;
                    } catch(e) {
                        icon = child.getAttribute('icon') || ''; // 如果 URL 格式有问题，尝试取原有的图标作为垫底
                    }
                    currentGroup.links.push({
                        name: child.textContent.trim(),
                        url: child.href,
                        icon: icon
                    });
                }
            } 
            else if (tagName === 'DL' || tagName === 'DT' || tagName === 'P') {
                // 继续深入
                traverseBookmarks(child, currentGroup, results);
            }
        });
    }

    document.getElementById('fileInput').onchange = (e) => {
        if (!e.target.files.length) return;
        const reader = new FileReader();
        reader.onload = (ev) => {
            const parser = new DOMParser();
            const doc = parser.parseFromString(ev.target.result, 'text/html');
            const results = [];
        
            traverseBookmarks(doc.body, null, results);
        
            // 过滤空分组
            let validGroups = results.filter(g => g.links.length > 0);

            if (validGroups.length > 0) {
                let addedGroupCount = 0;
                let addedLinkCount = 0;

                validGroups.forEach(newGroup => {
                    // 检查 bData 是否已有同名分组
                    const existingGroup = bData.find(g => g.group === newGroup.group);
                
                    if (existingGroup) {
                        // 分组存在，追加新链接（去重 URL）
                        newGroup.links.forEach(l => {
                            if (!existingGroup.links.some(el => el.url === l.url)) {
                                existingGroup.links.push(l);
                                addedLinkCount++;
                            }
                        });
                    } else {
                        // 新分组，直接添加
                        bData.push(newGroup);
                        addedGroupCount++;
                        addedLinkCount += newGroup.links.length;
                    }
                });

                scheduleSaveData();
                scheduleRenderMain();
                showToast(`导入完成：新增 ${addedGroupCount} 个分组，新增 ${addedLinkCount} 个链接`);
            } else {
                alert('未找到有效书签，请确认文件格式。');
            }
        };
        reader.readAsText(e.target.files[0]);
        e.target.value = '';
    };


    // --- 6. 配置导入导出 (Point 6) ---
    async function exportConfig() {
        const config = {
            version: "3.0",
            data: bData,
            bg: await Store.get('nav_pro_bg')
            // search: els.searchSelect.value
        };
        const blob = new Blob([JSON.stringify(config)], {type: "application/json"});
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `Minimalist_Config_${new Date().toISOString().slice(0,10)}.json`;
        a.click();
    }

    document.getElementById('configInput').onchange = (e) => {
        if (!e.target.files.length) return;
        const reader = new FileReader();
        reader.onload = async (ev) => {
            try {
                const c = JSON.parse(ev.target.result);
                if (c.data && Array.isArray(c.data)) {
                    if(confirm("导入将覆盖当前所有数据，确定吗？")) {
                        bData = c.data;
                        if(c.bg) {
                            await Store.set('nav_pro_bg', c.bg);
                            document.body.style.backgroundImage = `url(${c.bg})`;
                        }
                        // if(c.search) {
                        //     await Store.set('nav_pro_search', c.search);
                        //     els.searchSelect.value = c.search;
                        // }
                        scheduleSaveData();
                        scheduleRenderMain();
                        showToast("配置还原成功");
                    }
                } else {
                    alert("配置文件格式错误");
                }
            } catch(err) { alert("文件解析失败"); }
        };
        reader.readAsText(e.target.files[0]);
        e.target.value = '';
    };

    // 背景图(限制 1MB)
    document.getElementById('bgInput').onchange = (e) => {
        if (!e.target.files.length) return;
        const file = e.target.files[0];
        const maxBgSize = 1024 * 1024; // 1MB
        if (file.size > maxBgSize) {
            alert(`背景图太大了！当前大小：${(file.size / 1024 / 1024).toFixed(1)}MB，请压缩至 1MB 以内，否则浏览器可能无法保存您的设置。`);
            e.target.value = '';
            return;
        }
        const reader = new FileReader();
        reader.onload = async (ev) => {
            document.body.style.backgroundImage = `url(${ev.target.result})`;
            await Store.set('nav_pro_bg', ev.target.result); // 这里保存了大图
            showToast("壁纸设置成功");
        };
        reader.readAsDataURL(file);
    };

    // --- 辅助函数 ---
    async function saveData() {
        try {
            await Store.set('nav_elite_data', bData); // 使用 Store.set
        } catch(e) {
            alert("数据过大(图片过多)，可能无法保存到本地缓存，建议导出配置文件备份。");
        }
    }

    function updateOrder() {
        if (!bData || bData.length === 0) return;
        const newData = [];
        // 按照拖拽后的 DOM 顺序重新抓取数据
        const nodes = els.mainGrid.querySelectorAll('.group-node');
        nodes.forEach(node => {
            const idx = node.getAttribute('data-idx');
            if (idx !== null) {
                newData.push(bData[parseInt(idx)]);
            }
        });
        // 更新数据并重新渲染一次（重置 data-idx）
        bData = newData;
        scheduleSaveData();
        scheduleRenderMain();
    }

    function showToast(msg) {
        const t = document.getElementById('toast');
        t.innerText = msg;
        t.style.opacity = '1';
        setTimeout(() => t.style.opacity = '0', 2000);
    }
    
    // --- 自动化数据加载逻辑 ---
    async function initDataPipeline() {
        // 优先级 1: 读取存储 (使用通用 Store)
        const stored = await Store.get('nav_elite_data'); // 使用 await Store.get
        if (stored !== null) {
            try { 
                // Store.get 已经帮我们做了解析，这里直接赋值
                bData = stored; 
                console.log("✅ 存在缓存：从存储加载数据");
                // const savedEngine = await Store.get('nav_pro_search');
                // if (savedEngine) {
                //     els.searchSelect.value = savedEngine;
                // }
                return; // 命中缓存，直接跳出，不再读取原始文件
            } catch(e) { console.error("解析缓存失败:", e); }
        }
        // 优先级 2: 尝试加载 JSON 配置文件
        const jsonPath = 'data/Minimalist_Config.json';
        try {
            const response = await fetch(jsonPath);
            if (response.ok) {
                const config = await response.json();
                if (config.data) {
                    bData = config.data;
                    // if (config.search) els.searchSelect.value = config.search;
                    console.log("✅ 首次启动：从 JSON 自动导入数据");
                    // 立刻落盘，避免每次刷新都“首次启动”
                    try { await Store.set('nav_elite_data', bData); } catch(e) {}
                    return; // 成功则跳出
                }
            }
        } catch (e) { console.warn("未找到 JSON 配置文件或解析失败"); }

        // 优先级 3: 尝试加载 Chrome 书签 HTML
        const htmlPath = 'data/bookmarks.html';
        try {
            const response = await fetch(htmlPath);
            if (response.ok) {
                const htmlText = await response.text();
                const parser = new DOMParser();
                const doc = parser.parseFromString(htmlText, 'text/html');
                const results = [];
                traverseBookmarks(doc.body, null, results);
                const validGroups = results.filter(g => g.links.length > 0);
                if (validGroups.length > 0) {
                    bData = validGroups; // 覆盖初始数据
                    console.log("✅ 首次启动：从 HTML 自动导入书签");
                    // 立刻落盘，避免每次刷新都“首次启动”
                    try { await Store.set('nav_elite_data', bData); } catch(e) {}
                    return;
                }
            }
        } catch (e) { console.warn("未找到书签 HTML 文件"); }
        
        // 如果三种都失败，保证 bData 是数组
        bData = [];
    }

    // 自动加载背景图
    async function tryLoadBackground() {
        // 优先级 1: 先看缓存里有没有手动设置过的壁纸 (Base64)
        const cachedBg = await Store.get('nav_pro_bg');
        if (cachedBg) {
            document.body.style.backgroundImage = `url(${cachedBg})`;
            console.log("✅ 使用手动设置的个性化壁纸");
            return;
        }

        // 优先级 2: 如果没有手动设置，加载 data 文件夹里的默认背景
        const bgPath = 'data/Background.jpg';
        // 先检查 data 目录下是否有图
        const img = new Image();
        img.src = bgPath;
        img.onload = () => {
            document.body.style.backgroundImage = `url(${bgPath})`;
            console.log("✅ 成功加载本地背景图");
        };
        img.onerror = () => {
            console.log("ℹ️ 未发现默认壁纸，使用 CSS 默认底色");
        };
    }
    
    /**
     * 助手函数：尝试从多个渠道获取高清图标
     * 按照数组顺序进行尝试，成功即返回
     */
    async function fetchHighResIcon(hostname) {
        // 定义图标 API 渠道
        const apis = [
            `https://www.google.com/s2/favicons?sz=64&domain=${hostname}`,  // Google (64px，锁定第一位：全球最强兜底)
            `https://api.iowen.cn/favicon/${hostname}.png`,                 // iowen (国内较快，接口在国内 CDN 加速非常出色，且图标质量较高)
            `https://www.favicon.vip/get.php?url=${hostname}`,              // Favicon.vip (国内次选，是国内老牌接口，适合作为 iowen 的补充)
            `https://icons.duckduckgo.com/ip3/${hostname}.ico`,             // DuckDuckGo (国际优秀渠道： 的响应速度通常优于 IconHorse 和 FaviconKit)
            `https://api.faviconkit.com/${hostname}/64`,                    // faviconkit (国际备选)
            `https://icon.horse/icon/${hostname}`,                          // Icon Horse (国际备选)
            `https://${hostname}/favicon.ico`                               // 最后的兜底：尝试直接访问原站（最慢且最易失败，放在最后）
        ];
        let fallbackUrl = null; // 用于记录第一个抓取到的、但不满足64px的图标
        for (const url of apis) {
            try {
                const result = await new Promise((resolve) => {
                    const img = new Image();
                    const timer = setTimeout(() => { 
                        img.src = "";
                        resolve({ success: false }); 
                    },3000); // 设置超时，防止某个 API 挂起导致卡死
                
                    img.onload = () => {
                        clearTimeout(timer);
                        // 16 为设定的最低录取图标尺寸值（同时也防止 1x1 透明像素这种无效的图像）
                        if (img.naturalWidth >= 16) {
                            resolve({ 
                                success: true, 
                                width: img.naturalWidth 
                            });
                        } else {
                            resolve({ success: false });
                        }
                    };
                    img.onerror = () => {
                        clearTimeout(timer);
                        resolve({ success: false });
                    };
                    img.src = url;
                });
                if (result.success) {
                    // 1. 如果宽度符合要求，直接返回该渠道
                    if (result.width >= 64) {
                        return url;
                    }
                    // 2. 如果宽度不达标，优先使用 >=32px 的，>=32px 的也没有就使用第一次获取到的 >=16px 图标
                    if (result.width >= 32) {
                            fallbackUrl = url;
                    } else {
                        if (!fallbackUrl) {
                            fallbackUrl = url;
                        }
                    }
                }
            } catch (e) {
                continue; // 尝试下一个
            }
        }
        return fallbackUrl; // 如果循环结束都没找到 >= 64px 的，则返回备胎小图（如果有的话）
    }

    /**
     * 一键修复全站模糊图标
     * 逻辑：
     * 1. 检查所有链接图标
     * 2. 跳过用户手动上传的高清长 Base64 (自定义图片通常很大)
     * 3. 对书签导入的短 Base64 或旧的图标链接进行高清替换
     * 4. 替换失败时（如 API 无法访问）保持原样
     */
    async function repairAllIcons() {
        showToast("正在尝试获取高清图标，请稍候..."); // 显示处理中的提示
        let repairCount = 0;
        let skipCount = 0;
        
        // 遍历所有分组
        for (const group of bData) {
            // 遍历分组下的所有链接
            for (const link of group.links) {
                const oldIcon = link.icon || '';
                // const isNoIcon = oldIcon === ''; // 判断当前是否完全没图标
                
                // 如果图标是 Base64 且长度非常大 (通常 > 8000 字符)，认为是用户自定义上传的图片，或者已经是 API 渠道抓来的图标，跳过
                const isApiIcon = [
                    's2/favicons',   // Google 特有路径
                    'iowen',         // iowen 品牌名
                    'favicon.vip',   // 完整域名防止误判
                    'duckduckgo',    // 品牌名
                    'faviconkit',    // 品牌名
                    'icon.horse',    // 品牌名
                    'favicon.ico'    // 原站路径
                ].some(keyword => oldIcon.includes(keyword));
                if ((oldIcon.startsWith('data:image') && oldIcon.length > 8000) || isApiIcon) {
                    skipCount++;
                    continue;
                }

                try {
                    const u = new URL(link.url);
                    // 如果是内网地址，单独处理，不走 Google 等云端 API
                    if (u.hostname.match(/^(\d|localhost|homeassistant|192\.|127\.|10\.|172\.)/)) {
                        // 尝试直接访问该站点的根目录图标
                        // 保持原有的协议 (http 或 https)
                        const localIcon = `${u.origin}/favicon.ico`; 
                        const isOk = await new Promise((resolve) => {
                            const img = new Image();
                            const timer = setTimeout(() => { img.src = ""; resolve(false); }, 1000); // 内网响应通常很快，超时设短一点
                            img.onload = () => { clearTimeout(timer); resolve(img.naturalWidth > 0); };
                            img.onerror = () => { clearTimeout(timer); resolve(false); };
                            img.src = localIcon;
                        });
                        if (isOk) {
                            link.icon = localIcon;
                            repairCount++;
                        } else {
                            skipCount++; // 如果内网设备自己不提供 favicon.ico，云端 API 肯定也拿不到
                        }
                        continue; // 处理完内网，无论成功失败，跳过后面的云端 API 循环
                    }
                    
                    // 公网多渠道尝试
                    const highResIcon = await fetchHighResIcon(u.hostname);
                    if (highResIcon) {
                        link.icon = highResIcon;
                        repairCount++;
                    } else {
                        skipCount++;
                    }
                } catch (e) {
                    // 转换失败或 URL 非法，保持原样
                    skipCount++;
                }
            }
        }

        if (repairCount > 0) {
            scheduleSaveData();   // 保存到 LocalStorage
            scheduleRenderMain(); // 重新渲染界面
            showToast(`成功修复 ${repairCount} 个图标！${skipCount} 个图标保持原样。`);
        } else {
            showToast("未发现需要修复的图标。");
        }
    }