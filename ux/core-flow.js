/* Smart Fridge core UX enhancement.
 * Safe additive UI layer on top of PR #4. No stock RPCs, mutation helpers or dinner hooks.
 * All original element IDs, callbacks, and data arrays remain unchanged.
 */
(function(){
  'use strict';
  function init(){
    const home=document.getElementById('screen-home');
    const fridge=document.getElementById('screen-fridge');
    if(!home || !fridge || home.dataset.sfUxMounted==='yes')return;
    home.dataset.sfUxMounted='yes';

    // Keep the original dynamic contents and existing click listeners; only move nodes.
    const summary=document.getElementById('summary-section');
    const expiring=document.getElementById('expiring-row')?.closest('.section');
    const meals=document.getElementById('home-meals-row')?.closest('.section');
    const lowStock=document.getElementById('low-stock-section');
    const saveBanner=document.getElementById('save-banner-btn')?.closest('.section');
    if(summary && expiring && meals && lowStock && saveBanner){
      const intro=document.createElement('p');
      intro.className='sf-home-intro';
      intro.textContent='Что есть дома, что приготовить и что осталось купить.';
      const header=home.querySelector('.topbar');
      if(header)header.insertAdjacentElement('afterend',intro);

      const grid=document.createElement('div');
      grid.className='sf-home-grid';
      const primary=document.createElement('div');
      primary.className='sf-home-column';
      const secondary=document.createElement('div');
      secondary.className='sf-home-column';

      const title=document.createElement('h2');
      title.textContent='1. Есть дома';
      title.className='sf-home-section-title';
      title.style.marginBottom='.875rem';
      summary.prepend(title);
      primary.append(summary,expiring);

      const nutritionEnabled=typeof SF_NUTRITION_ENABLED!=='undefined' && SF_NUTRITION_ENABLED;
      if(nutritionEnabled){
        const mealsTitle=meals.querySelector('.section-head h2');
        if(mealsTitle)mealsTitle.textContent='2. Приготовить · план питания';
        const mealHint=document.createElement('p');
        mealHint.className='sf-home-subhead';
        mealHint.textContent='План питания — не подтверждение наличия всех ингредиентов. Проверяйте состав перед приготовлением.';
        const mealHead=meals.querySelector('.section-head');
        if(mealHead)mealHead.insertAdjacentElement('afterend',mealHint);
        secondary.append(meals);
      }else{
        meals.hidden=true;
        secondary.append(meals);
        const unavailable=document.createElement('section');
        unavailable.className='sf-home-disabled';
        unavailable.innerHTML='<h2>2. Приготовить</h2><p>Питание и подбор блюд временно недоступны: идёт проверка. Продукты и покупки продолжают работать.</p><span class="sf-unavailable-label">Пока недоступно</span>';
        secondary.append(unavailable);
      }

      const buy=document.createElement('section');
      buy.className='sf-home-buy';
      buy.innerHTML='<h2>3. Купить</h2><p>Список покупок обновляется после подтверждённого сохранения. Предложенные ингредиенты не добавляются автоматически.</p><button type="button" class="secondary-btn" data-nav="cart">Открыть покупки</button>';
      buy.querySelector('[data-nav="cart"]').addEventListener('click',()=>document.querySelector('.side-item[data-nav="cart"]')?.click());
      secondary.append(buy,lowStock);
      grid.append(primary,secondary);
      home.insertBefore(grid,saveBanner);
      saveBanner.classList.add('sf-home-bottom');
    }

    // Never promise cookability based on partial matching: this remains inspiration only.
    const suggest=document.getElementById('suggest-row');
    const list=document.getElementById('fridge-list');
    if(suggest && list){
      const heading=fridge.querySelector('.section-head h2');
      const headingSection=heading?.closest('.section');
      const wrapper=document.createElement('section');
      wrapper.className='sf-suggestions';
      const caption=document.createElement('p');
      caption.className='sf-disclaimer';
      caption.textContent=typeof SF_NUTRITION_ENABLED!=='undefined' && SF_NUTRITION_ENABLED?'Идеи для вдохновения. Проверяйте ингредиенты и количество.':'Подбор блюд временно недоступен. Сохранённые продукты и покупки доступны.';
      if(heading)heading.textContent='Идеи блюд';
      if(headingSection)wrapper.appendChild(headingSection);
      wrapper.appendChild(caption);
      wrapper.appendChild(suggest);
      list.insertAdjacentElement('afterend',wrapper);

      // Search only filters already-rendered confirmed rows; no speculative stock totals.
      const tools=document.createElement('div');
      tools.className='sf-stock-tools';
      const label=document.createElement('label');
      label.htmlFor='sf-stock-search';
      label.textContent='Поиск по продуктам';
      const input=document.createElement('input');
      input.id='sf-stock-search';
      input.className='sf-stock-search';
      input.type='search';
      input.placeholder='Например, молоко';
      input.autocomplete='off';
      const count=document.createElement('p');
      count.className='sf-stock-result';
      count.id='sf-stock-result';
      count.setAttribute('role','status');
      count.setAttribute('aria-live','polite');
      tools.append(label,input,count);
      const segmented=fridge.querySelector('.segmented');
      if(segmented)fridge.insertBefore(tools,segmented);
      function applyFilter(){
        const needle=input.value.trim().toLocaleLowerCase('ru');
        const rows=Array.from(list.querySelectorAll('.product-row[data-list]'));
        let shown=0;
        for(const row of rows){
          if(!row.dataset.sfKeyboardReady){
            row.tabIndex=0;row.setAttribute('role','button');
            row.setAttribute('aria-label','Открыть продукт: '+(row.querySelector('.product-info .n')?.textContent||''));
            row.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();row.click();}});
            row.dataset.sfKeyboardReady='yes';
          }
          const name=row.querySelector('.product-info .n')?.textContent||'';
          const hit=name.toLocaleLowerCase('ru').includes(needle);
          row.hidden=!hit;
          if(hit)shown++;
        }
        count.textContent=needle?(shown?'Найдено: '+shown:'Ничего не найдено. Очистите поиск.'):'';
      }
      input.addEventListener('input',applyFilter);
      new MutationObserver(applyFilter).observe(list,{childList:true});
      applyFilter();
    }

    // Keep data-nav routing, badges and listeners intact while giving controls readable names.
    const labels={home:'Сегодня',fridge:'Продукты',vision:'Сканировать',diet:'Питание',cart:'Покупки'};
    document.querySelectorAll('.side-item[data-nav],.nav-item[data-nav]').forEach(button=>{
      const label=labels[button.dataset.nav];
      if(!label)return;
      const text=Array.from(button.childNodes).find(n=>n.nodeType===Node.TEXT_NODE && n.textContent.trim());
      if(text)text.textContent=label;
    });
    if(typeof SF_NUTRITION_ENABLED!=='undefined' && !SF_NUTRITION_ENABLED){
      document.querySelectorAll('.side-item[data-nav="diet"],.side-item[data-nav="recipes"],.nav-item[data-nav="diet"],.nav-item[data-nav="recipes"]').forEach(button=>{
        if(button.dataset.nav==='recipes' && typeof SF_DINNER_ENABLED!=='undefined' && SF_DINNER_ENABLED)return;
        button.disabled=true;
        button.title='Функция пока проходит проверку';
        button.setAttribute('aria-label',button.textContent.trim()+' — пока недоступно');
      });
    }
    const sidebar=home.closest('#app')?.querySelector('.sidebar');
    const visionNav=sidebar?.querySelector('.side-item[data-nav="vision"]');
    const profileNav=sidebar?.querySelector('.side-item[data-nav="profile"]');
    if(visionNav && profileNav)profileNav.insertAdjacentElement('afterend',visionNav);
    const fridgeHeading=fridge.querySelector('.topbar h1');
    if(fridgeHeading)fridgeHeading.textContent='Продукты';
    const cartHeading=document.querySelector('#screen-cart .topbar h1');
    if(cartHeading)cartHeading.textContent='Покупки';
    const dietHeading=document.querySelector('#screen-diet .topbar h1');
    if(dietHeading)dietHeading.textContent='Питание';

    // In the product detail, everyday consumption precedes infrequent editing.
    const use=document.getElementById('use-product-btn');
    const edit=document.getElementById('edit-open-btn');
    if(use&&edit&&use.parentNode===edit.parentNode){
      use.classList.remove('secondary-btn');
      use.classList.add('primary-btn');
      edit.classList.remove('primary-btn');
      edit.classList.add('secondary-btn');
      edit.parentNode.insertBefore(use,edit);
    }

    // Product entry is implemented in the native manual sheet. Keep RPC callbacks intact.
    const manual=document.getElementById('manual-sheet');
    const clearError=()=>{
      const err=document.getElementById('manual-custom-error');
      if(err){err.textContent='';err.hidden=true;}
      for(const id of ['manual-custom-name','manual-custom-qty'])document.getElementById(id)?.removeAttribute('aria-invalid');
    };
    if(manual){
      for(const id of ['manual-custom-name','manual-custom-qty','manual-custom-unit','manual-custom-expiry']){
        document.getElementById(id)?.addEventListener('input',clearError);
      }
    }
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
})();
