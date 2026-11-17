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
      // Calm home: one decision first (what to cook), then what spoils soon, what to buy, and the month's benefit.
      document.querySelector('#screen-home > p.section')?.remove();
      const grid=document.createElement('div');
      grid.className='sf-home-grid';
      const primary=document.createElement('div');
      primary.className='sf-home-column';
      const secondary=document.createElement('div');
      secondary.className='sf-home-column';

      const dinnerOn=typeof SF_DINNER_ENABLED!=='undefined' && SF_DINNER_ENABLED;
      const decide=document.createElement('section');
      decide.className='sf-home-decide';decide.id='sf-home-decide';decide.hidden=!dinnerOn;
      decide.innerHTML='<p class="sf-eyebrow" id="sf-decide-eyebrow">Сегодня на ужин</p><h2 id="sf-decide-title">Подбираем блюдо из ваших продуктов…</h2><p class="sf-decide-note" id="sf-decide-note"></p><button type="button" class="primary-btn" id="sf-decide-go">Что приготовить</button>';
      decide.querySelector('#sf-decide-go').addEventListener('click',()=>document.querySelector('.nav-item[data-nav="recipes"],.side-item[data-nav="recipes"]')?.click());
      window.addEventListener('sf:dinner-best',event=>{
        const d=event.detail||{};decide.hidden=!dinnerOn;
        const meal={breakfast:'завтрак',lunch:'обед',dinner:'ужин'}[d.meal]||'ужин';
        decide.querySelector('#sf-decide-eyebrow').textContent='Сегодня на '+meal;
        decide.querySelector('#sf-decide-title').textContent=d.title||(d.reason==='profile'?'Создайте профиль — подскажем, что приготовить':'Добавьте продукты — подскажем блюдо');
        decide.querySelector('#sf-decide-note').textContent=d.title?(d.status==='enough'?'Всё есть дома':d.status==='buy'?'Не хватает: '+d.missing.join(', '):'Уточните пару продуктов — и можно готовить'):'';
        decide.dataset.status=d.status||'none';
        decide.querySelector('#sf-decide-go').textContent=d.title?'Готовлю':'Открыть';
      });

      const expHead=expiring.querySelector('.section-head h2');
      if(expHead)expHead.textContent='Скоро испортится';
      summary.classList.add('sf-home-stats');
      primary.append(decide,expiring,summary);

      // Old "ideas" row is replaced by the decision card above; nutrition plan stays an owner extra.
      const nutritionEnabled=typeof SF_NUTRITION_ENABLED!=='undefined' && SF_NUTRITION_ENABLED;
      meals.hidden=!nutritionEnabled;
      if(nutritionEnabled){const mealsTitle=meals.querySelector('.section-head h2');if(mealsTitle)mealsTitle.textContent='План питания';}
      secondary.append(meals);

      const buy=document.createElement('section');
      buy.className='sf-home-buy';
      buy.innerHTML='<h2>Купить</h2><p id="sf-home-buy-count">Список покупок пуст</p><button type="button" class="secondary-btn" data-nav="cart">Открыть покупки</button>';
      buy.querySelector('[data-nav="cart"]').addEventListener('click',()=>document.querySelector('.nav-item[data-nav="cart"],.side-item[data-nav="cart"]')?.click());
      const badge=document.querySelector('.nav-item[data-nav="cart"] .badge,#cart-badge');
      const paintBuy=()=>{const n=typeof cartData!=='undefined'?cartData.length:0;const forms=['позиция','позиции','позиций'];const k=n%10===1&&n%100!==11?0:n%10>=2&&n%10<=4&&(n%100<10||n%100>=20)?1:2;
        buy.querySelector('#sf-home-buy-count').textContent=n?n+' '+forms[k]+' в списке':'Список покупок пуст';};
      paintBuy();window.addEventListener('sf:inventory',paintBuy);if(badge)new MutationObserver(paintBuy).observe(badge,{childList:true,characterData:true,subtree:true});
      secondary.append(buy,lowStock,saveBanner.closest('.section')||saveBanner);
      grid.append(primary,secondary);
      home.appendChild(grid);
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
