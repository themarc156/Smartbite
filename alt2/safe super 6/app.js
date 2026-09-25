const CONFIG = Object.freeze({
    TOTAL_DAYS: 28 
});

// Hardware-beschleunigte, speicherschonende Bildkomprimierung ohne RAM-Spikes
async function compressImageFile(file, maxWidth = 1200, quality = 0.82) {
    if (!file || !file.type.startsWith('image/')) return file;

    // 1. Bevorzugt: createImageBitmap (direktes Decoding ohne Speicherlast)
    if ('createImageBitmap' in window) {
        try {
            const bitmap = await createImageBitmap(file);
            let width = bitmap.width;
            let height = bitmap.height;

            if (width > maxWidth || height > maxWidth) {
                if (width > height) {
                    height = Math.round((height * maxWidth) / width);
                    width = maxWidth;
                } else {
                    width = Math.round((width * maxWidth) / height);
                    height = maxWidth;
                }
            }

            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(bitmap, 0, 0, width, height);
            bitmap.close(); // Gibt den VRAM-Speicher sofort frei

            return new Promise((resolve) => {
                canvas.toBlob((blob) => {
                    if (!blob) {
                        resolve(file);
                        return;
                    }
                    resolve(new File([blob], file.name.replace(/\.[^/.]+$/, "") + ".jpg", {
                        type: 'image/jpeg',
                        lastModified: Date.now()
                    }));
                }, 'image/jpeg', quality);
            });
        } catch (err) {
            console.warn('createImageBitmap fehlgeschlagen, nutze ObjectURL Fallback', err);
        }
    }

    // 2. Fallback: URL.createObjectURL (kein speicherhungriger Base64-FileReader)
    return new Promise((resolve) => {
        const objectUrl = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => {
            URL.revokeObjectURL(objectUrl); // Speicher sofort freigeben
            let width = img.width;
            let height = img.height;

            if (width > maxWidth || height > maxWidth) {
                if (width > height) {
                    height = Math.round((height * maxWidth) / width);
                    width = maxWidth;
                } else {
                    width = Math.round((width * maxWidth) / height);
                    height = maxWidth;
                }
            }

            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, width, height);

            canvas.toBlob((blob) => {
                if (!blob) {
                    resolve(file);
                    return;
                }
                resolve(new File([blob], file.name.replace(/\.[^/.]+$/, "") + ".jpg", {
                    type: 'image/jpeg',
                    lastModified: Date.now()
                }));
            }, 'image/jpeg', quality);
        };
        img.onerror = () => {
            URL.revokeObjectURL(objectUrl);
            resolve(file);
        };
        img.src = objectUrl;
    });
}

let wakeLockSentinel = null;

const appState = {
    dishes: [],
    currentPlan: [],
    currentWeekPage: 0, 
    activeFilter: 'all',
    searchQuery: '',
    selectModeForDayId: null,     
    currentViewingDishId: null,   
    draggedDayId: null,
    isGridView: true,
    currentPortions: 4,
    basePortions: 4,
    currentView: 'plan'
};

function scaleIngredient(line, factor) {
    if (factor === 1) return line;
    // Sucht Zahlen am Anfang oder nach Leerzeichen (z.B. "500g", "2.5", "1 1/2")
    return line.replace(/(\d+([.,]\d+)?)/g, (match) => {
        const num = parseFloat(match.replace(',', '.'));
        if (isNaN(num)) return match;
        const scaled = num * factor;
        // Schöne Rundung: maximal 2 Nachkommastellen, keine unnötigen Nullen
        const formatted = Number(scaled.toFixed(2)).toString().replace('.', ',');
        return formatted;
    });
}

async function enableWakeLock() {
    try {
        if ('wakeLock' in navigator) {
            wakeLockSentinel = await navigator.wakeLock.request('screen');
        }
    } catch (err) {
        console.log('Wake Lock nicht verfügbar:', err);
    }
}

function releaseWakeLock() {
    if (wakeLockSentinel) {
        wakeLockSentinel.release();
        wakeLockSentinel = null;
    }
}

function getWeekNumber(d) {
    d = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}

function getMonday(d) {
    d = new Date(d);
    const day = d.getDay();
    const diff = d.getDate() - day + (day === 0 ? -6 : 1);
    return new Date(d.setDate(diff));
}

async function loadData() {
    try {
        const res = await fetch('/api/data');
        if (!res.ok) throw new Error('API Fehler');
        const data = await res.json();
        appState.dishes = data.dishes || [];
        appState.currentPlan = data.plan || [];
    } catch (e) {
        console.error('Ladefehler:', e);
    }
    renderApp();
}

async function saveDishToApi(dishPayload) {
    const res = await fetch('/api/dishes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(dishPayload)
    });
    return res.json();
}

async function deleteDishFromApi(dishId) {
    await fetch(`/api/dishes/${dishId}`, { method: 'DELETE' });
    appState.dishes = appState.dishes.filter(d => d.id !== dishId);
    renderApp();
}

async function savePlanToApi() {
    await fetch('/api/plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan: appState.currentPlan })
    });
}

const WEEKDAY_SHORT = {
    'Montag': 'Mo',
    'Dienstag': 'Di',
    'Mittwoch': 'Mi',
    'Donnerstag': 'Do',
    'Freitag': 'Fr',
    'Samstag': 'Sa',
    'Sonntag': 'So'
};

function generate4WeekPlan() {
    const plan = [];
    const startMonday = getMonday(new Date());
    const mainDishesOnly = (appState.dishes || []).filter(d => d.isMeat !== 'baking');
    const poolSource = mainDishesOnly.length > 0 ? mainDishesOnly : [];
    if (poolSource.length === 0) return;

    let availablePool = [...poolSource];

    for (let i = 0; i < CONFIG.TOTAL_DAYS; i++) {
        const currentDate = new Date(startMonday);
        currentDate.setDate(startMonday.getDate() + i);

        if (availablePool.length === 0) {
            availablePool = [...poolSource];
        }

        const randomIndex = Math.floor(Math.random() * availablePool.length);
        const selectedDish = availablePool[randomIndex];
        availablePool.splice(randomIndex, 1);

        plan.push({
            id: `day-${Date.now()}-${i}`,
            dateTimeline: currentDate.getTime(),
            dateString: currentDate.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' }),
            dayName: currentDate.toLocaleDateString('de-DE', { weekday: 'long' }),
            kw: getWeekNumber(currentDate),
            dishName: selectedDish.name,
            dishId: selectedDish.id,
            isEmergency: selectedDish.isEmergency || false,
            isMeat: selectedDish.isMeat || false,
            isHighCarb: selectedDish.isHighCarb || false
        });
    }

    appState.currentPlan = plan;
    savePlanToApi();
    renderApp();
}

function assignDishToDay(dayId, dishObj) {
    const dayIndex = appState.currentPlan.findIndex(d => d.id === dayId);
    if (dayIndex === -1) return;

    appState.currentPlan[dayIndex].dishName = dishObj.name;
    appState.currentPlan[dayIndex].dishId = dishObj.id;
    appState.currentPlan[dayIndex].isEmergency = dishObj.isEmergency || false;
    appState.currentPlan[dayIndex].isMeat = dishObj.isMeat || false;
    appState.currentPlan[dayIndex].isHighCarb = dishObj.isHighCarb || false;

    savePlanToApi();
    renderApp();
}

function swapDaysInPlan(sourceDayId, targetDayId) {
    if (!sourceDayId || !targetDayId || sourceDayId === targetDayId) return;

    const sourceIdx = appState.currentPlan.findIndex(d => d.id === sourceDayId);
    const targetIdx = appState.currentPlan.findIndex(d => d.id === targetDayId);

    if (sourceIdx === -1 || targetIdx === -1) return;

    const temp = { ...appState.currentPlan[sourceIdx] };
    
    appState.currentPlan[sourceIdx].dishName = appState.currentPlan[targetIdx].dishName;
    appState.currentPlan[sourceIdx].dishId = appState.currentPlan[targetIdx].dishId;
    appState.currentPlan[sourceIdx].isEmergency = appState.currentPlan[targetIdx].isEmergency;
    appState.currentPlan[sourceIdx].isMeat = appState.currentPlan[targetIdx].isMeat;
    appState.currentPlan[sourceIdx].isHighCarb = appState.currentPlan[targetIdx].isHighCarb;

    appState.currentPlan[targetIdx].dishName = temp.dishName;
    appState.currentPlan[targetIdx].dishId = temp.dishId;
    appState.currentPlan[targetIdx].isEmergency = temp.isEmergency;
    appState.currentPlan[targetIdx].isMeat = temp.isMeat;
    appState.currentPlan[targetIdx].isHighCarb = temp.isHighCarb;

    savePlanToApi();
    renderApp();
}

function renderRecipeIngredients(dish) {
    const ingredientsList = document.getElementById('recipe-view-ingredients');
    ingredientsList.innerHTML = '';
    const factor = appState.currentPortions / appState.basePortions;
    const ingredientsLines = (dish.ingredients || '').split('\n').map(s => s.trim()).filter(Boolean);
    
    if (ingredientsLines.length === 0) {
        ingredientsList.innerHTML = '<li style="list-style: none; color: var(--text-muted);">Keine Zutaten hinterlegt</li>';
        return;
    }

    ingredientsLines.forEach(ing => {
        const scaledText = scaleIngredient(ing, factor);
        const li = document.createElement('li');
        li.className = 'ingredient-item';
        
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        
        const textSpan = document.createElement('span');
        textSpan.textContent = scaledText;

        li.appendChild(checkbox);
        li.appendChild(textSpan);

        li.addEventListener('click', (e) => {
            if (e.target !== checkbox) checkbox.checked = !checkbox.checked;
            li.classList.toggle('checked', checkbox.checked);
        });

        ingredientsList.appendChild(li);
    });
}

function switchRecipeModalMode(mode) {
    const isEdit = (mode === 'edit');
    document.getElementById('recipe-view-header').classList.toggle('hidden', isEdit);
    document.getElementById('recipe-view-body').classList.toggle('hidden', isEdit);
    document.getElementById('recipe-edit-header').classList.toggle('hidden', !isEdit);
    document.getElementById('recipe-edit-body').classList.toggle('hidden', !isEdit);
}


function openRecipeModal(dish) {
    appState.currentViewingDishId = dish.id;
    appState.currentPortions = 4;
    switchRecipeModalMode('view');
    
    document.getElementById('portion-count-label').textContent = `${appState.currentPortions} Portionen`;
    document.getElementById('recipe-view-title').textContent = dish.name;
    
    // Link-Button anzeigen, falls eine URL hinterlegt ist
    const linkContainer = document.getElementById('recipe-link-container');
    const sourceLink = document.getElementById('recipe-source-link');
    if (dish.sourceUrl) {
        sourceLink.href = dish.sourceUrl;
        linkContainer.classList.remove('hidden');
    } else {
        linkContainer.classList.add('hidden');
    }

    const badgesContainer = document.getElementById('recipe-view-badges');
    badgesContainer.innerHTML = '';
    
    const typeBadge = document.createElement('span');
    if (dish.isMeat === 'baking') {
        typeBadge.className = 'badge-pill badge-pill-baking';
        typeBadge.textContent = '🍰 Backen';
    } else if (dish.isMeat === true) {
        typeBadge.className = 'badge-pill badge-pill-meat';
        typeBadge.textContent = '🥩 Fleisch';
    } else if (dish.isMeat === false) {
        typeBadge.className = 'badge-pill badge-pill-veggie';
        typeBadge.textContent = '🌱 Vegetarisch';
    } else {
        typeBadge.className = 'badge-pill badge-pill-carb';
        typeBadge.textContent = '🍲 Flexibel';
    }
    badgesContainer.appendChild(typeBadge);

    if (dish.isHighCarb) {
        const carbBadge = document.createElement('span');
        carbBadge.className = 'badge-pill badge-pill-carb';
        carbBadge.textContent = '🌾 High-Carb';
        badgesContainer.appendChild(carbBadge);
    }

    if (dish.isEmergency) {
        const emergencyBadge = document.createElement('span');
        emergencyBadge.className = 'badge-pill badge-pill-emergency';
        emergencyBadge.textContent = '🚨 Notfall-Gericht';
        badgesContainer.appendChild(emergencyBadge);
    }

    // Vorschaubild anzeigen
    const previewContainer = document.getElementById('recipe-preview-image-container');
    const previewElement = document.getElementById('recipe-preview-image');
    if (dish.previewImage) {
        previewElement.src = dish.previewImage;
        previewContainer.classList.remove('hidden');
    } else {
        previewContainer.classList.add('hidden');
    }

    // Screenshot anzeigen
    const imgContainer = document.getElementById('recipe-view-image-container');
    const imgElement = document.getElementById('recipe-view-image');
    if (dish.image) {
        imgElement.src = dish.image;
        imgContainer.classList.remove('hidden');
    } else {
        imgContainer.classList.add('hidden');
    }

    renderRecipeIngredients(dish);

    const instructionsEl = document.getElementById('recipe-view-instructions');
    instructionsEl.textContent = dish.instructions || 'Keine Zubereitungsschritte hinterlegt.';

    enableWakeLock();
    document.getElementById('recipe-view-modal').classList.remove('hidden');
}

function renderApp() {
    const dishCountSpan = document.getElementById('dish-count');
    const dishList = document.getElementById('dish-list');
    const instructionText = document.getElementById('database-instruction');

    if (dishCountSpan && dishList) {
        let filteredDishes = [...appState.dishes];

        if (appState.searchQuery.trim() !== '') {
            const query = appState.searchQuery.toLowerCase();
            filteredDishes = filteredDishes.filter(d => 
                d.name.toLowerCase().includes(query) || 
                (d.ingredients && d.ingredients.toLowerCase().includes(query)) ||
                (d.instructions && d.instructions.toLowerCase().includes(query))
            );
        }
        
        // 1. Strikte Trennung: Backen vs. Alltagsgerichte
        if (appState.activeFilter === 'baking') {
            // Exklusiv nur Kuchen & Backrezepte anzeigen
            filteredDishes = filteredDishes.filter(d => d.isMeat === 'baking');
        } else {
            // Ausnahmslos ALLE anderen Filter (Alle, High-Carb, Low-Carb, Notfall, Flexi, Veggie, Meat) schliessen Backrezepte aus
            filteredDishes = filteredDishes.filter(d => d.isMeat !== 'baking');

            if (appState.activeFilter === 'highcarb') {
                filteredDishes = filteredDishes.filter(d => d.isHighCarb === true);
            } else if (appState.activeFilter === 'lowcarb') {
                filteredDishes = filteredDishes.filter(d => !d.isHighCarb);
            } else if (appState.activeFilter === 'emergency') {
                filteredDishes = filteredDishes.filter(d => d.isEmergency === true);
            } else if (appState.activeFilter === 'veggie') {
                filteredDishes = filteredDishes.filter(d => d.isMeat === false);
            } else if (appState.activeFilter === 'flex') {
                filteredDishes = filteredDishes.filter(d => d.isMeat === null || d.isMeat === undefined);
            } else if (appState.activeFilter === 'meat') {
                filteredDishes = filteredDishes.filter(d => d.isMeat === true);
            }
        }

        dishCountSpan.textContent = filteredDishes.length;
        dishList.innerHTML = '';
        dishList.classList.toggle('grid-view', appState.isGridView);

        if (appState.selectModeForDayId) {
            dishList.classList.add('select-mode');
            if (instructionText) instructionText.innerHTML = "🎯 <strong>Auswahl-Modus:</strong> Klicke auf ein Gericht, um es in den Plan einzutragen!";
        } else {
            dishList.classList.remove('select-mode');
            if (instructionText) instructionText.textContent = "Klicke auf ein Gericht für Rezeptdetails und Zubereitung.";
        }

        filteredDishes.forEach(dish => {
            const li = document.createElement('li');

            // 1. Grid-Ansicht Rendern
            if (appState.isGridView) {
                const displayImg = dish.previewImage || dish.image;
                if (displayImg) {
                    const img = document.createElement('img');
                    img.src = displayImg;
                    img.className = 'dish-card-img';
                    img.alt = dish.name;
                    li.appendChild(img);
                } else {
                    const placeholder = document.createElement('div');
                    placeholder.className = 'dish-card-placeholder';
                    placeholder.textContent = dish.isMeat === true ? '🥩' : (dish.isMeat === false ? '🌱' : '🍲');
                    li.appendChild(placeholder);
                }

                const cardBody = document.createElement('div');
                cardBody.className = 'dish-card-body';

                const title = document.createElement('div');
                title.className = 'dish-card-title';
                title.textContent = dish.name;

                const badges = document.createElement('div');
                badges.className = 'recipe-badges-container';
                const typeIcon = dish.isMeat === true ? '🥩' : (dish.isMeat === false ? '🌱' : '🍲');
                badges.innerHTML = `<span style="font-size: 0.85rem;">${typeIcon} ${dish.isHighCarb ? '🌾' : ''} ${dish.isEmergency ? '🚨' : ''}</span>`;

                cardBody.appendChild(title);
                cardBody.appendChild(badges);
                li.appendChild(cardBody);

                li.addEventListener('click', () => {
                    if (appState.selectModeForDayId) {
                        assignDishToDay(appState.selectModeForDayId, dish);
                        appState.selectModeForDayId = null;
                        switchView('plan');
                    } else {
                        openRecipeModal(dish);
                    }
                });
            } else {
                // 2. Reine Listen Ansicht
                const leftSide = document.createElement('div');
                leftSide.className = 'dish-left-side';

                const toggleTypeBtn = document.createElement('button');
                toggleTypeBtn.className = 'btn-toggle-status active';
                toggleTypeBtn.title = 'Typ umschalten (Veggie / Fleisch / Flexi)';
                
                if (dish.isMeat === true) {
                    toggleTypeBtn.textContent = '🥩';
                } else if (dish.isMeat === false) {
                    toggleTypeBtn.textContent = '🌱';
                } else {
                    toggleTypeBtn.textContent = '🍲';
                }

                toggleTypeBtn.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    if (dish.isMeat === false) {
                        dish.isMeat = true;
                    } else if (dish.isMeat === true) {
                        dish.isMeat = null;
                    } else {
                        dish.isMeat = false;
                    }
                    await saveDishToApi(dish);
                    renderApp();
                });

                const nameSpan = document.createElement('span');
                nameSpan.className = 'dish-clickable-name';
                nameSpan.textContent = dish.name;
                nameSpan.addEventListener('click', () => {
                    if (appState.selectModeForDayId) {
                        assignDishToDay(appState.selectModeForDayId, dish);
                        appState.selectModeForDayId = null;
                        switchView('plan');
                    } else {
                        openRecipeModal(dish);
                    }
                });

                // Toggle-Funktion in der Listenansicht: Klick schaltet durch (false -> true -> 'baking' -> null -> false)
                if (dish.isMeat === 'baking') {
                    toggleTypeBtn.textContent = '🍰';
                }

                leftSide.appendChild(toggleTypeBtn);
                leftSide.appendChild(nameSpan);
                li.appendChild(leftSide);
            }

            dishList.appendChild(li);
        });
    }

    if (appState.currentPlan.length > 0) {
        const startIdx = appState.currentWeekPage * 7;
        const endIdx = startIdx + 7;
        const activeWeekDays = appState.currentPlan.slice(startIdx, endIdx);

        const kwTitle = document.getElementById('modal-kw-title');
        if (kwTitle && activeWeekDays.length > 0) {
            kwTitle.textContent = `KW ${activeWeekDays[0].kw}`;
        }

        const modalGrid = document.getElementById('modal-plan-grid');
        if (modalGrid) {
            modalGrid.innerHTML = '';

            activeWeekDays.forEach(day => {
                const card = document.createElement('div');
                card.className = 'modal-day-card';
                card.setAttribute('draggable', 'true');

                // Prüfen, ob dieser Tag heute ist
                const todayStr = new Date().toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
                const isToday = (day.dateString === todayStr);
                if (isToday) {
                    card.classList.add('is-today');
                }

                card.addEventListener('dragstart', (e) => {
                    appState.draggedDayId = day.id;
                    e.dataTransfer.effectAllowed = 'move';
                });

                card.addEventListener('dragover', (e) => {
                    e.preventDefault();
                    card.classList.add('drag-over');
                });

                card.addEventListener('dragleave', () => {
                    card.classList.remove('drag-over');
                });

                card.addEventListener('drop', (e) => {
                    e.preventDefault();
                    card.classList.remove('drag-over');
                    if (appState.draggedDayId && appState.draggedDayId !== day.id) {
                        swapDaysInPlan(appState.draggedDayId, day.id);
                    }
                    appState.draggedDayId = null;
                });

                const infoWrapper = document.createElement('div');
                infoWrapper.className = 'modal-day-info-wrapper';

                // Spalte 1: Wochentag-Kürzel oben (Mo, Di...), Datum darunter
                const shortDay = WEEKDAY_SHORT[day.dayName] || day.dayName.slice(0, 2);
                const dateCol = document.createElement('div');
                dateCol.className = 'modal-day-name-col';
                dateCol.innerHTML = `
                    <span class="modal-day-weekday">${shortDay}</span>
                    <span class="modal-day-date-text">${day.dateString}</span>
                `;

                // Spalte 2: Miniatur-Vorschaubild des Gerichts (Holt Daten live aus der Datenbank, falls vorhanden)
                const dishObj = appState.dishes.find(d => d.id === day.dishId || d.name === day.dishName);
                
                // Live-Synchronisation der Attribute, falls sich das Rezept in der Datenbank geändert hat
                if (dishObj) {
                    day.isMeat = dishObj.isMeat;
                    day.isHighCarb = dishObj.isHighCarb;
                    day.isEmergency = dishObj.isEmergency;
                }

                let thumbEl;
                const thumbImage = dishObj ? (dishObj.previewImage || dishObj.image) : null;
                if (thumbImage) {
                    thumbEl = document.createElement('img');
                    thumbEl.src = thumbImage;
                    thumbEl.className = 'plan-dish-thumb';
                    thumbEl.alt = day.dishName;
                } else {
                    thumbEl = document.createElement('div');
                    thumbEl.className = 'plan-dish-thumb-placeholder';
                    thumbEl.textContent = day.isMeat === true ? '🥩' : (day.isMeat === false ? '🌱' : '🍲');
                }

                // Spalte 3: Nur noch dezent der Carb-Indikator + Rezeptname
                const dishRow = document.createElement('div');
                dishRow.className = 'modal-dish-row';

                const leftBadges = document.createElement('div');
                leftBadges.className = 'modal-left-badges';

                const carbBadge = document.createElement('span');
                carbBadge.textContent = '🌾';
                carbBadge.className = day.isHighCarb ? 'badge-carb-indicator' : 'badge-carb-indicator badge-inactive';
                leftBadges.appendChild(carbBadge);

                const dishName = document.createElement('div');
                dishName.className = 'modal-dish-name clickable-recipe-link';
                dishName.textContent = day.dishName;
                dishName.title = 'Klicken, um Rezept-Details zu öffnen';
                dishName.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const dishObj = appState.dishes.find(d => d.id === day.dishId || d.name === day.dishName);
                    if (dishObj) {
                        openRecipeModal(dishObj);
                    } else {
                        // Fallback für ungespeicherte Gerichte
                        openRecipeModal({
                            id: day.dishId,
                            name: day.dishName,
                            isMeat: day.isMeat,
                            isHighCarb: day.isHighCarb,
                            isEmergency: day.isEmergency,
                            ingredients: '',
                            instructions: 'Kein Rezept hinterlegt.'
                        });
                    }
                });

                dishRow.appendChild(leftBadges);
                dishRow.appendChild(dishName);

                infoWrapper.appendChild(dateCol);
                infoWrapper.appendChild(thumbEl);
                infoWrapper.appendChild(dishRow);

                const rightActions = document.createElement('div');
                rightActions.className = 'modal-right-actions';

                const changeDishBtn = document.createElement('button');
                changeDishBtn.className = 'btn-icon-action';
                changeDishBtn.textContent = '🔄';
                changeDishBtn.title = 'Gericht für diesen Tag ändern';
                changeDishBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    appState.selectModeForDayId = day.id;
                    switchView('database');
                    renderApp();
                });
                rightActions.appendChild(changeDishBtn);

                card.appendChild(infoWrapper);
                card.appendChild(rightActions);
                modalGrid.appendChild(card);
            });
        }
    }

    const prevBtn = document.getElementById('btn-prev-week');
    const nextBtn = document.getElementById('btn-next-week');
    if (prevBtn) prevBtn.disabled = (appState.currentWeekPage === 0);
    if (nextBtn) nextBtn.disabled = (appState.currentWeekPage === 3);
}

const VIEW_ORDER = ['plan', 'database', 'add'];

function switchView(viewName, animationType = 'fade') {
    const views = {
        plan: document.getElementById('view-plan'),
        database: document.getElementById('view-database'),
        add: document.getElementById('view-add')
    };

    const tabs = {
        plan: document.getElementById('nav-btn-plan'),
        database: document.getElementById('nav-btn-database'),
        add: document.getElementById('nav-btn-add')
    };

    Object.keys(views).forEach(key => {
        if (views[key]) {
            views[key].classList.add('hidden');
            views[key].classList.remove('view-enter-from-right', 'view-enter-from-left', 'view-enter-fade');
        }
        if (tabs[key]) tabs[key].classList.remove('active');
    });

    const activeViewEl = views[viewName];
    if (activeViewEl) {
        activeViewEl.classList.remove('hidden');
        if (animationType === 'forward') {
            activeViewEl.classList.add('view-enter-from-right');
        } else if (animationType === 'backward') {
            activeViewEl.classList.add('view-enter-from-left');
        } else {
            activeViewEl.classList.add('view-enter-fade');
        }
    }
    if (tabs[viewName]) tabs[viewName].classList.add('active');

    appState.currentView = viewName;

    if (viewName === 'plan' && appState.currentPlan.length === 0) {
        generate4WeekPlan();
    }
}

function navigateViewByOffset(offset) {
    const currentIndex = VIEW_ORDER.indexOf(appState.currentView || 'plan');
    if (currentIndex === -1) return;
    const newIndex = currentIndex + offset;
    if (newIndex >= 0 && newIndex < VIEW_ORDER.length) {
        const targetView = VIEW_ORDER[newIndex];
        const animationType = offset > 0 ? 'forward' : 'backward';
        appState.selectModeForDayId = null;
        if (targetView === 'add') resetDishForm();
        switchView(targetView, animationType);
        if (targetView !== 'add') renderApp();
    }
}

let touchStartX = 0;
let touchStartY = 0;
let touchStartTime = 0;

document.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
    touchStartTime = Date.now();
}, { passive: true });

document.addEventListener('touchend', (e) => {
    if (e.changedTouches.length !== 1) return;

    const recipeModal = document.getElementById('recipe-view-modal');
    const shoppingModal = document.getElementById('shopping-list-modal');
    if ((recipeModal && !recipeModal.classList.contains('hidden')) ||
        (shoppingModal && !shoppingModal.classList.contains('hidden'))) {
        return;
    }

    const targetTag = e.target && e.target.tagName ? e.target.tagName.toLowerCase() : '';
    if (targetTag === 'input' || targetTag === 'textarea' || targetTag === 'select') {
        return;
    }

    const deltaX = e.changedTouches[0].clientX - touchStartX;
    const deltaY = e.changedTouches[0].clientY - touchStartY;
    const elapsed = Date.now() - touchStartTime;

    if (elapsed < 500 && Math.abs(deltaX) > 60 && Math.abs(deltaX) > Math.abs(deltaY) * 1.5) {
        if (deltaX < 0) {
            navigateViewByOffset(1);
        } else {
            navigateViewByOffset(-1);
        }
    }
}, { passive: true });

// Direkte Klick-Steuerung für Pillen
window.selectDishType = function(buttonElement, value, targetInputId) {
    const input = document.getElementById(targetInputId);
    if (input) input.value = value;
    
    const group = buttonElement.closest('.pill-selector-group');
    if (group) {
        group.querySelectorAll('button').forEach(btn => btn.classList.remove('active'));
    }
    buttonElement.classList.add('active');
};

// Programmatische Steuerung (z.B. beim Öffnen zum Bearbeiten)
window.setMeatPill = function(val) {
    const input = document.getElementById('dish-meat-val');
    if (input) input.value = val;
    const form = document.getElementById('dish-form');
    if (form) {
        form.querySelectorAll('.pill-selector-group button').forEach(btn => {
            btn.classList.toggle('active', btn.getAttribute('data-val') === val);
        });
    }
};

window.setModalMeatPill = function(val) {
    const input = document.getElementById('modal-edit-meat-val');
    if (input) input.value = val;
    const form = document.getElementById('modal-dish-edit-form');
    if (form) {
        form.querySelectorAll('.pill-selector-group button').forEach(btn => {
            btn.classList.toggle('active', btn.getAttribute('data-val') === val);
        });
    }
};

function openEditRecipeForm(dish) {
    document.getElementById('dish-edit-id').value = dish.id;
    document.getElementById('dish-name').value = dish.name || '';
    
    if (dish.isMeat === 'baking') setMeatPill('baking');
    else if (dish.isMeat === true) setMeatPill('meat');
    else if (dish.isMeat === false) setMeatPill('veggie');
    else setMeatPill('flex');

    document.getElementById('dish-highcarb').checked = !!dish.isHighCarb;
    document.getElementById('dish-emergency').checked = !!dish.isEmergency;
    document.getElementById('dish-ingredients').value = dish.ingredients || '';
    document.getElementById('dish-instructions').value = dish.instructions || '';
    document.getElementById('dish-image-file').value = '';

    document.getElementById('form-heading-title').textContent = `Rezept bearbeiten: ${dish.name}`;
    document.getElementById('btn-submit-dish').textContent = 'Änderungen speichern 💾';
    document.getElementById('btn-cancel-edit').classList.remove('hidden');

    // Löschbutton im Formular einblenden & zurücksetzen
    const deleteInFormBtn = document.getElementById('btn-delete-in-form');
    deleteInFormBtn.classList.remove('hidden', 'confirm-mode');
    deleteInFormBtn.textContent = '🗑️ Rezept löschen';

    switchView('add');
}

function resetDishForm() {
    document.getElementById('dish-edit-id').value = '';
    document.getElementById('dish-name').value = '';
    document.getElementById('dish-ingredients').value = '';
    document.getElementById('dish-instructions').value = '';
    document.getElementById('dish-image-file').value = '';
    setMeatPill('flex');
    document.getElementById('dish-emergency').checked = false;
    document.getElementById('dish-highcarb').checked = false;

    document.getElementById('form-heading-title').textContent = 'Neues Rezept anlegen';
    document.getElementById('btn-submit-dish').textContent = 'Gericht speichern';
    document.getElementById('btn-cancel-edit').classList.add('hidden');
    document.getElementById('btn-delete-in-form').classList.add('hidden');
}

// Wörterbuch für die Regal-Reihenfolge im Supermarkt
const SUPERMARKET_CATEGORIES = [
    {
        name: '🍏 Obst & Gemüse',
        keywords: ['zwiebel', 'knoblauch', 'tomate', 'paprika', 'kartoffel', 'salat', 'gurke', 'karotte', 'möhre', 'zucchini', 'ananas', 'basilikum', 'kräuter', 'avocado', 'petersilie', 'apfel', 'zitrone', 'champignon', 'pilz']
    },
    {
        name: '🍞 Brot & Backwaren',
        keywords: ['brot', 'toast', 'brötchen', 'buns', 'wrap', 'tortilla', 'mehl', 'hefe', 'pizzateig', 'grieß']
    },
    {
        name: '🥩 Fleisch, Fisch & Frischetheke',
        keywords: ['hackfleisch', 'rinderhack', 'hähnchen', 'schinken', 'speck', 'matjes', 'wurst', 'pinkel', 'patty', 'rind']
    },
    {
        name: '🧀 Kühlregal & Molkerei',
        keywords: ['milch', 'butter', 'käse', 'gouda', 'feta', 'quark', 'sahne', 'ei', 'eier', 'frischkäse', 'mozzarella', 'creme fraiche', 'joghurt', 'maultaschen']
    },
    {
        name: '🍝 Vorrat, Teigwaren & Dosen',
        keywords: ['nudel', 'spaghetti', 'pasta', 'reis', 'kidneybohne', 'bohne', 'mais', 'dose', 'tomatenmark', 'passierte tomaten', 'gehackte tomaten', 'brühe', 'zucker', 'öl', 'olivenöl']
    },
    {
        name: '🥫 Gewürze, Saucen & Sonstiges',
        keywords: ['salz', 'pfeffer', 'oregano', 'zimt', 'curry', 'paprikapulver', 'chili', 'kreuzkümmel', 'senf', 'ketchup', 'mayo', 'remoulade', 'sauce', 'soße']
    }
];

let shoppingTimeframe = 'kw'; // 'kw' oder '7days'
let customShoppingItems = [];

function categorizeIngredient(text) {
    const lower = text.toLowerCase();
    for (const cat of SUPERMARKET_CATEGORIES) {
        if (cat.keywords.some(k => lower.includes(k))) {
            return cat.name;
        }
    }
    return '📦 Sonstige Lebensmittel';
}

function parseAndAggregateIngredients(rawList) {
    const aggregated = {};

    rawList.forEach(({ text, dishName }) => {
        // Trennt führende Mengenangaben (z.B. "500g", "2 Dosen", "1") vom Zutatennamen
        const match = text.match(/^([\d.,/]+(?:\s*[a-zA-Z]+)?)\s+(.*)$/);
        let amount = '';
        let item = text.trim();

        if (match) {
            amount = match[1].trim();
            item = match[2].trim();
        }

        const key = item.toLowerCase();
        if (!aggregated[key]) {
            aggregated[key] = {
                displayName: item,
                category: categorizeIngredient(item),
                sources: []
            };
        }

        aggregated[key].sources.push({ amount, dishName });
    });

    return aggregated;
}

function renderShoppingListModal() {
    let daysToInclude = [];
    let titleText = '';

    if (shoppingTimeframe === 'kw') {
        const startIdx = appState.currentWeekPage * 7;
        daysToInclude = appState.currentPlan.slice(startIdx, startIdx + 7);
        const kw = daysToInclude.length > 0 ? daysToInclude[0].kw : '--';
        titleText = `🛒 Einkaufsliste (KW ${kw})`;
    } else {
        const todayMs = new Date().setHours(0, 0, 0, 0);
        // Sortiert und sucht die nächsten 7 Tage ab heute im gesamten 28-Tage-Plan
        const upcoming = appState.currentPlan.filter(d => d.dateTimeline >= todayMs);
        daysToInclude = (upcoming.length >= 7) ? upcoming.slice(0, 7) : appState.currentPlan.slice(0, 7);
        titleText = `🛒 Einkaufsliste (Nächste 7 Tage)`;
    }

    document.getElementById('shopping-list-title').textContent = titleText;

    const rawIngredients = [];
    const unparsedDishes = [];

    daysToInclude.forEach(day => {
        const dish = appState.dishes.find(d => d.id === day.dishId || d.name === day.dishName);
        if (dish) {
            const lines = (dish.ingredients || '').split('\n').map(s => s.trim()).filter(Boolean);
            if (lines.length > 0) {
                lines.forEach(line => rawIngredients.push({ text: line, dishName: dish.name }));
            } else if (dish.image || dish.sourceUrl) {
                if (!unparsedDishes.some(d => d.id === dish.id)) {
                    unparsedDishes.push(dish);
                }
            }
        }
    });

    // Unparsed-Hinweise rendern
    const unparsedBox = document.getElementById('shopping-unparsed-box');
    const unparsedChips = document.getElementById('shopping-unparsed-links');
    unparsedChips.innerHTML = '';

    if (unparsedDishes.length > 0) {
        unparsedBox.classList.remove('hidden');
        unparsedDishes.forEach(d => {
            const btn = document.createElement('button');
            btn.className = 'unparsed-chip';
            btn.textContent = `${d.name} ↗`;
            btn.addEventListener('click', () => {
                document.getElementById('shopping-list-modal').classList.add('hidden');
                openRecipeModal(d);
            });
            unparsedChips.appendChild(btn);
        });
    } else {
        unparsedBox.classList.add('hidden');
    }

    // Aggregieren & nach Supermarkt-Regalen sortieren
    const aggregated = parseAndAggregateIngredients(rawIngredients);
    const categorizedMap = {};

    Object.values(aggregated).forEach(item => {
        if (!categorizedMap[item.category]) categorizedMap[item.category] = [];
        categorizedMap[item.category].push(item);
    });

    // Manuelle Artikel einbinden
    if (customShoppingItems.length > 0) {
        const customCat = '📝 Manuell hinzugefügt';
        categorizedMap[customCat] = customShoppingItems.map(name => ({
            displayName: name,
            category: customCat,
            sources: [{ amount: '', dishName: 'Eigener Artikel' }]
        }));
    }

    const container = document.getElementById('shopping-list-container');
    container.innerHTML = '';

    if (Object.keys(categorizedMap).length === 0) {
        container.innerHTML = '<p class="subtitle" style="text-align: center;">Keine Zutaten für den gewählten Zeitraum gefunden.</p>';
        return;
    }

    // Gerenderte Kategorien in fester Reihenfolge ausgeben
    const allKnownCatNames = [...SUPERMARKET_CATEGORIES.map(c => c.name), '📦 Sonstige Lebensmittel', '📝 Manuell hinzugefügt'];

    allKnownCatNames.forEach(catName => {
        const items = categorizedMap[catName];
        if (!items || items.length === 0) return;

        const groupEl = document.createElement('div');
        groupEl.className = 'shopping-category-group';

        const titleEl = document.createElement('div');
        titleEl.className = 'shopping-category-title';
        titleEl.textContent = catName;
        groupEl.appendChild(titleEl);

        const listEl = document.createElement('ul');
        listEl.className = 'ingredients-rendered-list';

        items.forEach(item => {
            const li = document.createElement('li');
            li.className = 'ingredient-item';

            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';

            const textSpan = document.createElement('span');
            
            // Formatierung: 500g Hackfleisch (Bolognese) oder 2x Zwiebel (Suppe, Pizza)
            const amountsText = item.sources.map(s => s.amount ? `${s.amount} [${s.dishName}]` : `[${s.dishName}]`).join(', ');
            textSpan.innerHTML = `<strong>${item.displayName}</strong> <span style="font-size: 0.78rem; color: var(--text-muted);">(${amountsText})</span>`;

            li.appendChild(checkbox);
            li.appendChild(textSpan);

            li.addEventListener('click', (e) => {
                if (e.target !== checkbox) checkbox.checked = !checkbox.checked;
                li.classList.toggle('checked', checkbox.checked);
            });

            listEl.appendChild(li);
        });

        groupEl.appendChild(listEl);
        container.appendChild(groupEl);
    });
}

function openShoppingListModal() {
    renderShoppingListModal();
    document.getElementById('shopping-list-modal').classList.remove('hidden');
}

document.addEventListener('DOMContentLoaded', () => {
    loadData();

    const recipeViewModal = document.getElementById('recipe-view-modal');
    const shoppingListModal = document.getElementById('shopping-list-modal');

    // Portionen-Scaler Buttons
    document.getElementById('btn-portion-dec').addEventListener('click', () => {
        if (appState.currentPortions > 1) {
            appState.currentPortions--;
            document.getElementById('portion-count-label').textContent = `${appState.currentPortions} Portionen`;
            const dish = appState.dishes.find(d => d.id === appState.currentViewingDishId);
            if (dish) renderRecipeIngredients(dish);
        }
    });

    document.getElementById('btn-portion-inc').addEventListener('click', () => {
        if (appState.currentPortions < 20) {
            appState.currentPortions++;
            document.getElementById('portion-count-label').textContent = `${appState.currentPortions} Portionen`;
            const dish = appState.dishes.find(d => d.id === appState.currentViewingDishId);
            if (dish) renderRecipeIngredients(dish);
        }
    });

    // Einkaufsliste öffnen & schließen
    document.getElementById('btn-open-shopping-list').addEventListener('click', openShoppingListModal);
    document.getElementById('btn-close-shopping-list').addEventListener('click', () => {
        shoppingListModal.classList.add('hidden');
    });

    // Zeitraum-Buttons im Einkaufslisten-Modal
    const btnTfKw = document.getElementById('btn-timeframe-kw');
    const btnTf7Days = document.getElementById('btn-timeframe-7days');

    if (btnTfKw && btnTf7Days) {
        btnTfKw.addEventListener('click', () => {
            shoppingTimeframe = 'kw';
            btnTfKw.classList.add('active');
            btnTf7Days.classList.remove('active');
            renderShoppingListModal();
        });

        btnTf7Days.addEventListener('click', () => {
            shoppingTimeframe = '7days';
            btnTf7Days.classList.add('active');
            btnTfKw.classList.remove('active');
            renderShoppingListModal();
        });
    }

    // Manuelle Artikel hinzufügen
    const customInput = document.getElementById('shopping-custom-input');
    const btnAddCustom = document.getElementById('btn-add-custom-item');

    const handleAddCustom = () => {
        const val = customInput.value.trim();
        if (val) {
            customShoppingItems.push(val);
            customInput.value = '';
            renderShoppingListModal();
        }
    };

    if (btnAddCustom) btnAddCustom.addEventListener('click', handleAddCustom);
    if (customInput) customInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') handleAddCustom(); });

    // Als Text in die Zwischenablage kopieren (z.B. für WhatsApp)
    const btnCopy = document.getElementById('btn-copy-shopping-list');
    if (btnCopy) {
        btnCopy.addEventListener('click', () => {
            let text = `${document.getElementById('shopping-list-title').textContent}\n\n`;
            document.querySelectorAll('.shopping-category-group').forEach(group => {
                const catTitle = group.querySelector('.shopping-category-title').textContent;
                text += `--- ${catTitle} ---\n`;
                group.querySelectorAll('.ingredient-item').forEach(item => {
                    if (!item.classList.contains('checked')) {
                        text += `• ${item.querySelector('span').textContent}\n`;
                    }
                });
                text += '\n';
            });
            navigator.clipboard.writeText(text);
            btnCopy.textContent = '✓ Kopiert!';
            setTimeout(() => { btnCopy.textContent = '📋 Kopieren'; }, 2000);
        });
    }

    // Umschalten in den Bearbeitungsmodus direkt im Modal
    document.getElementById('btn-edit-recipe').addEventListener('click', () => {
        const dish = appState.dishes.find(d => d.id === appState.currentViewingDishId);
        if (!dish) return;

        document.getElementById('modal-edit-id').value = dish.id;
        document.getElementById('modal-edit-name').value = dish.name || '';
        document.getElementById('modal-edit-url').value = dish.sourceUrl || '';
        
        if (dish.isMeat === 'baking') {
            setModalMeatPill('baking');
        } else if (dish.isMeat === true) {
            setModalMeatPill('meat');
        } else if (dish.isMeat === false) {
            setModalMeatPill('veggie');
        } else {
            setModalMeatPill('flex');
        }

        document.getElementById('modal-edit-highcarb').checked = !!dish.isHighCarb;
        document.getElementById('modal-edit-emergency').checked = !!dish.isEmergency;
        document.getElementById('modal-edit-ingredients').value = dish.ingredients || '';
        document.getElementById('modal-edit-instructions').value = dish.instructions || '';
        document.getElementById('modal-edit-image-file').value = '';
        const previewFileInput = document.getElementById('modal-edit-preview-file');
        if (previewFileInput) previewFileInput.value = '';
        const modalCamInput = document.getElementById('modal-edit-preview-file-cam');
        if (modalCamInput) modalCamInput.value = '';
        const modalHintLabel = document.getElementById('modal-preview-file-hint');
        if (modalHintLabel) modalHintLabel.textContent = '';

        const deleteBtn = document.getElementById('btn-modal-delete-dish');
        deleteBtn.classList.remove('confirm-mode');
        deleteBtn.textContent = '🗑️ Löschen';

        switchRecipeModalMode('edit');
    });

    // Abbrechen im Modal-Edit-Modus
    document.getElementById('btn-modal-cancel-edit').addEventListener('click', () => {
        switchRecipeModalMode('view');
    });

    // (Pillen-Auswahl wird direkt über inline onclick="setMeatPill(...)" gesteuert)

    // Löschen direkt aus dem Modal-Editor mit 2-Klick-Sicherheitsabfrage
    document.getElementById('btn-modal-delete-dish').addEventListener('click', async () => {
        const deleteBtn = document.getElementById('btn-modal-delete-dish');
        const dishId = document.getElementById('modal-edit-id').value;
        if (!dishId) return;

        if (!deleteBtn.classList.contains('confirm-mode')) {
            deleteBtn.classList.add('confirm-mode');
            deleteBtn.textContent = 'Wirklich löschen? ⚠️';
            setTimeout(() => {
                if (deleteBtn) {
                    deleteBtn.classList.remove('confirm-mode');
                    deleteBtn.textContent = '🗑️ Löschen';
                }
            }, 3000);
            return;
        }

        await deleteDishFromApi(dishId);
        recipeViewModal.classList.add('hidden');
        appState.currentViewingDishId = null;
        renderApp();
    });

    // Absenden des Bearbeitungs-Formulars im Modal
    document.getElementById('modal-dish-edit-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const editId = document.getElementById('modal-edit-id').value;
        const name = document.getElementById('modal-edit-name').value.trim();
        if (!name) return;

        const fileInput = document.getElementById('modal-edit-image-file');
        const previewFileInput = document.getElementById('modal-edit-preview-file');
        const existingDish = appState.dishes.find(d => d.id === editId);
        
        let imageUrl = existingDish ? (existingDish.image || '') : '';
        let previewImageUrl = existingDish ? (existingDish.previewImage || '') : '';

        // Screenshot komprimieren & hochladen
        if (fileInput.files.length > 0) {
            const compressed = await compressImageFile(fileInput.files[0], 1600, 0.85);
            const formData = new FormData();
            formData.append('image', compressed);
            try {
                const uploadRes = await fetch('/api/upload', { method: 'POST', body: formData });
                const uploadData = await uploadRes.json();
                imageUrl = uploadData.imageUrl || imageUrl;
            } catch (err) {
                console.error('Screenshot-Upload fehlgeschlagen:', err);
            }
        }

        // Vorschaubild komprimieren & hochladen (Kamera oder Galerie)
        const modalCamFile = document.getElementById('modal-edit-preview-file-cam');
        const selectedModalPreviewFile = (modalCamFile && modalCamFile.files.length > 0) 
            ? modalCamFile.files[0] 
            : (previewFileInput && previewFileInput.files.length > 0 ? previewFileInput.files[0] : null);

        if (selectedModalPreviewFile) {
            const compressedPreview = await compressImageFile(selectedModalPreviewFile, 1200, 0.82);
            const formData = new FormData();
            formData.append('image', compressedPreview);
            try {
                const uploadRes = await fetch('/api/upload', { method: 'POST', body: formData });
                const uploadData = await uploadRes.json();
                previewImageUrl = uploadData.imageUrl || previewImageUrl;
            } catch (err) {
                console.error('Vorschaubild-Upload fehlgeschlagen:', err);
            }
        }

        const meatValInputEl = document.getElementById('modal-edit-meat-val');
        const meatValRaw = meatValInputEl ? meatValInputEl.value : 'flex';
        let meatVal = null;
        if (meatValRaw === 'baking') meatVal = 'baking';
        else if (meatValRaw === 'meat') meatVal = true;
        else if (meatValRaw === 'veggie') meatVal = false;

        const updatedPayload = {
            id: editId,
            name: name,
            sourceUrl: document.getElementById('modal-edit-url').value.trim(),
            isEmergency: document.getElementById('modal-edit-emergency').checked,
            isMeat: meatVal,
            isHighCarb: document.getElementById('modal-edit-highcarb').checked,
            ingredients: document.getElementById('modal-edit-ingredients').value,
            instructions: document.getElementById('modal-edit-instructions').value,
            image: imageUrl,
            previewImage: previewImageUrl
        };

        const res = await saveDishToApi(updatedPayload);
        if (res.dish) {
            const idx = appState.dishes.findIndex(d => d.id === res.dish.id);
            if (idx !== -1) appState.dishes[idx] = res.dish;
            openRecipeModal(res.dish);
        }

        renderApp();
    });

    document.getElementById('nav-btn-plan').addEventListener('click', () => {
        appState.selectModeForDayId = null;
        const currentIdx = VIEW_ORDER.indexOf(appState.currentView || 'plan');
        const targetIdx = 0;
        const anim = targetIdx > currentIdx ? 'forward' : (targetIdx < currentIdx ? 'backward' : 'fade');
        switchView('plan', anim);
        renderApp();
    });

    document.getElementById('nav-btn-database').addEventListener('click', () => {
        appState.selectModeForDayId = null;
        const currentIdx = VIEW_ORDER.indexOf(appState.currentView || 'plan');
        const targetIdx = 1;
        const anim = targetIdx > currentIdx ? 'forward' : (targetIdx < currentIdx ? 'backward' : 'fade');
        switchView('database', anim);
        renderApp();
    });

    document.getElementById('nav-btn-add').addEventListener('click', () => {
        appState.selectModeForDayId = null;
        const currentIdx = VIEW_ORDER.indexOf(appState.currentView || 'plan');
        const targetIdx = 2;
        const anim = targetIdx > currentIdx ? 'forward' : (targetIdx < currentIdx ? 'backward' : 'fade');
        resetDishForm();
        switchView('add', anim);
    });

    const btnCancelEdit = document.getElementById('btn-cancel-edit');
    if (btnCancelEdit) {
        btnCancelEdit.addEventListener('click', () => {
            resetDishForm();
            switchView('database');
        });
    }

    const btnToggleLayout = document.getElementById('btn-toggle-layout');
    if (btnToggleLayout) {
        btnToggleLayout.addEventListener('click', () => {
            appState.isGridView = !appState.isGridView;
            btnToggleLayout.textContent = appState.isGridView ? '🖼️' : '📋';
            renderApp();
        });
    }

    // Löschen direkt aus dem Bearbeitungs-Formular mit Sicherheitsabfrage
    const deleteInFormBtn = document.getElementById('btn-delete-in-form');
    if (deleteInFormBtn) {
        deleteInFormBtn.addEventListener('click', async () => {
            const editId = document.getElementById('dish-edit-id').value;
            if (!editId) return;

            if (!deleteInFormBtn.classList.contains('confirm-mode')) {
                deleteInFormBtn.classList.add('confirm-mode');
                deleteInFormBtn.textContent = 'Wirklich löschen? ⚠️';
                setTimeout(() => {
                    if (deleteInFormBtn) {
                        deleteInFormBtn.classList.remove('confirm-mode');
                        deleteInFormBtn.textContent = '🗑️ Rezept löschen';
                    }
                }, 3000);
                return;
            }

            await deleteDishFromApi(editId);
            resetDishForm();
            switchView('database');
            renderApp();
        });
    }

    // (Regenerate-Button entfernt)

    const closeRecipeView = () => {
        recipeViewModal.classList.add('hidden');
        appState.currentViewingDishId = null;
        releaseWakeLock();
    };

    document.getElementById('btn-close-recipe-view').addEventListener('click', closeRecipeView);

    // Klick auf den abgedunkelten Hintergrund schließt das Modal ebenfalls
    recipeViewModal.addEventListener('click', (e) => {
        if (e.target === recipeViewModal) {
            closeRecipeView();
        }
    });

    // ESC-Taste schließt das Modal
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !recipeViewModal.classList.contains('hidden')) {
            closeRecipeView();
        }
    });

    // (Alte Delete-Listener aus dem Rezept-Modal entfernt – Löschen findet nur noch im Formular statt)

    const searchInput = document.getElementById('dish-search-input');
    if (searchInput) {
        searchInput.addEventListener('input', (e) => {
            appState.searchQuery = e.target.value;
            renderApp();
        });
    }

    const filterButtons = {
        all: document.getElementById('filter-all'),
        baking: document.getElementById('filter-baking'),
        veggie: document.getElementById('filter-veggie'),
        flex: document.getElementById('filter-flex'),
        meat: document.getElementById('filter-meat'),
        lowcarb: document.getElementById('filter-lowcarb'),
        highcarb: document.getElementById('filter-highcarb'),
        emergency: document.getElementById('filter-emergency')
    };

    Object.keys(filterButtons).forEach(filterKey => {
        if (filterButtons[filterKey]) {
            filterButtons[filterKey].addEventListener('click', () => {
                Object.values(filterButtons).forEach(btn => { if(btn) btn.classList.remove('active'); });
                filterButtons[filterKey].classList.add('active');
                appState.activeFilter = filterKey;
                renderApp();
            });
        }
    });

    document.getElementById('btn-prev-week').addEventListener('click', () => {
        if (appState.currentWeekPage > 0) { appState.currentWeekPage--; renderApp(); }
    });
    document.getElementById('btn-next-week').addEventListener('click', () => {
        if (appState.currentWeekPage < 3) { appState.currentWeekPage++; renderApp(); }
    });

    // (Pillen-Listener über zentrale Event-Delegation gesteuert)

    // Dateinamen-Feedback bei Foto-Auswahl im Hauptformular
    const hintLabel = document.getElementById('preview-file-name-label');
    const camInput = document.getElementById('dish-preview-file-cam');
    const galInput = document.getElementById('dish-preview-file');

    if (camInput) {
        camInput.addEventListener('change', () => {
            if (camInput.files.length > 0) {
                if (galInput) galInput.value = '';
                if (hintLabel) hintLabel.textContent = `✓ Foto geknipst: ${camInput.files[0].name}`;
            }
        });
    }
    if (galInput) {
        galInput.addEventListener('change', () => {
            if (galInput.files.length > 0) {
                if (camInput) camInput.value = '';
                if (hintLabel) hintLabel.textContent = `✓ Aus Galerie: ${galInput.files[0].name}`;
            }
        });
    }

    // Dateinamen-Feedback im Bearbeiten-Modal
    const modalHintLabel = document.getElementById('modal-preview-file-hint');
    const modalCamInput = document.getElementById('modal-edit-preview-file-cam');
    const modalGalInput = document.getElementById('modal-edit-preview-file');

    if (modalCamInput) {
        modalCamInput.addEventListener('change', () => {
            if (modalCamInput.files.length > 0) {
                if (modalGalInput) modalGalInput.value = '';
                if (modalHintLabel) modalHintLabel.textContent = `✓ Foto geknipst: ${modalCamInput.files[0].name}`;
            }
        });
    }
    if (modalGalInput) {
        modalGalInput.addEventListener('change', () => {
            if (modalGalInput.files.length > 0) {
                if (modalCamInput) modalCamInput.value = '';
                if (modalHintLabel) modalHintLabel.textContent = `✓ Aus Galerie: ${modalGalInput.files[0].name}`;
            }
        });
    }

    document.getElementById('dish-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const nameInput = document.getElementById('dish-name');
        const emergencyInput = document.getElementById('dish-emergency');
        const meatValInput = document.getElementById('dish-meat-val');
        const highcarbInput = document.getElementById('dish-highcarb');
        const ingredientsInput = document.getElementById('dish-ingredients');
        const instructionsInput = document.getElementById('dish-instructions');
        const fileInput = document.getElementById('dish-image-file');
        const previewFileInput = document.getElementById('dish-preview-file');
        const sourceUrlInput = document.getElementById('dish-source-url');

        const name = nameInput.value.trim();
        if (!name) return;

        let imageUrl = '';
        let previewImageUrl = '';

        if (fileInput.files.length > 0) {
            const compressed = await compressImageFile(fileInput.files[0], 1600, 0.85);
            const formData = new FormData();
            formData.append('image', compressed);
            try {
                const uploadRes = await fetch('/api/upload', { method: 'POST', body: formData });
                const uploadData = await uploadRes.json();
                imageUrl = uploadData.imageUrl || '';
            } catch (err) {
                console.error('Screenshot-Upload fehlgeschlagen:', err);
            }
        }

        const editId = document.getElementById('dish-edit-id').value;
        const existingDish = editId ? appState.dishes.find(d => d.id === editId) : null;

        // Dateiauswahl für Kamera/Galerie abfangen & komprimieren
        const camFile = document.getElementById('dish-preview-file-cam');
        const selectedPreviewFile = (camFile && camFile.files.length > 0) ? camFile.files[0] : (previewFileInput && previewFileInput.files.length > 0 ? previewFileInput.files[0] : null);

        if (selectedPreviewFile) {
            const compressedPreview = await compressImageFile(selectedPreviewFile, 1200, 0.82);
            const formData = new FormData();
            formData.append('image', compressedPreview);
            try {
                const uploadRes = await fetch('/api/upload', { method: 'POST', body: formData });
                const uploadData = await uploadRes.json();
                previewImageUrl = uploadData.imageUrl || '';
            } catch (err) {
                console.error('Vorschaubild-Upload fehlgeschlagen:', err);
            }
        }

        if (!imageUrl && existingDish && existingDish.image) {
            imageUrl = existingDish.image;
        }
        if (!previewImageUrl && existingDish && existingDish.previewImage) {
            previewImageUrl = existingDish.previewImage;
        }

        const meatValRaw = meatValInput ? meatValInput.value : 'flex';
        let meatVal = null;
        if (meatValRaw === 'baking') meatVal = 'baking';
        else if (meatValRaw === 'meat') meatVal = true;
        else if (meatValRaw === 'veggie') meatVal = false;

        const dishPayload = {
            id: editId || undefined,
            name: name,
            sourceUrl: sourceUrlInput ? sourceUrlInput.value.trim() : '',
            isEmergency: emergencyInput.checked,
            isMeat: meatVal,
            isHighCarb: highcarbInput.checked,
            ingredients: ingredientsInput.value,
            instructions: instructionsInput.value,
            image: imageUrl,
            previewImage: previewImageUrl
        };

        const res = await saveDishToApi(dishPayload);
        if (res.dish) {
            const idx = appState.dishes.findIndex(d => d.id === res.dish.id);
            if (idx !== -1) {
                appState.dishes[idx] = res.dish;
            } else {
                appState.dishes.push(res.dish);
            }
        }

        resetDishForm();
        alert('Rezept erfolgreich gespeichert!');
        switchView('database');
        renderApp();
    });
});