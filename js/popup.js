document.addEventListener('DOMContentLoaded', async () => {
    const titleInput = document.getElementById('title');
    const urlInput = document.getElementById('url');
    const groupSelect = document.getElementById('groupSelect');
    const newGroupInput = document.getElementById('newGroupInput');
    const saveBtn = document.getElementById('saveBtn');
    const cancelBtn = document.getElementById('cancelBtn');

    // 1. 获取当前标签页信息 (仅在扩展模式下有效，需要 activeTab 权限)
    if (typeof chrome !== 'undefined' && chrome.tabs) {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab) {
            titleInput.value = tab.title || '';
            urlInput.value = tab.url || '';
        }
    }

    // 2. 加载主页数据 (使用 Store)
    let bData = [];
    const localData = await Store.get('nav_elite_data');
    if (localData) {
        bData = localData;
    }

    // 3. 渲染分组下拉框
    function renderGroups() {
        groupSelect.innerHTML = '';
        bData.forEach((g, i) => {
            const opt = document.createElement('option');
            opt.value = i;
            opt.textContent = g.group;
            groupSelect.appendChild(opt);
        });
        const addOpt = document.createElement('option');
        addOpt.value = 'NEW';
        addOpt.textContent = '+ 新建分组';
        groupSelect.appendChild(addOpt);
        checkNewGroupVisibility(); // 渲染完后，主动触发一次显示状态检查
    }
    
    // 4. 定义切换逻辑并绑定事件
    function checkNewGroupVisibility() {
        // 逻辑：如果选了 NEW，就显示输入框并聚焦；否则隐藏
        if (groupSelect.value === 'NEW') {
            newGroupInput.style.display = 'block';
            newGroupInput.focus();
        } else {
            newGroupInput.style.display = 'none';
        }
    }
    groupSelect.addEventListener('change', checkNewGroupVisibility); // 绑定改变事件
    renderGroups(); // 执行渲染
    
    // 5. 切换新建分组输入框
    //groupSelect.addEventListener('change', () => {
    //    newGroupInput.style.display = groupSelect.value === 'NEW' ? 'block' : 'none';
    //    if(groupSelect.value === 'NEW') newGroupInput.focus();
    //});

    // 6. 保存逻辑 (复刻 script.js)
    saveBtn.addEventListener('click', async () => {
        const title = titleInput.value.trim();
        const url = urlInput.value.trim();
        if (!title || !url) return alert('请填写完整信息');

        let icon = '';
        try {
            const host = new URL(url).hostname;
            icon = `https://www.google.com/s2/favicons?sz=64&domain=${host}`;
        } catch(e) { icon = ''; }

        const newItem = { name: title, url, icon };

        if (groupSelect.value === 'NEW') {
            const gName = newGroupInput.value.trim();
            if (!gName) return alert('请输入新分组名称');
            bData.push({ group: gName, links: [newItem] });
        } else {
            const idx = groupSelect.value;
            bData[idx].links.push(newItem);
        }

        // 存回共享的缓存，使用 Store.set 保存
        await Store.set('nav_elite_data', bData);
        
        // 反馈动画
        saveBtn.textContent = '添加成功！';
        saveBtn.style.background = '#00b894';
        setTimeout(() => window.close(), 600);
    });

    cancelBtn.addEventListener('click', () => window.close());
});