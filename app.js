    // ---------------------------------------------------------
        // 1. LIVE SUPABASE CONNECTION
        // ---------------------------------------------------------
        const SUPABASE_URL = 'https://juobkaftyrzlxbviudpy.supabase.co';
        const SUPABASE_ANON_KEY = 'sb_publishable_qdME8AYk9rz5B4FHs4Eb1g_0vvhN73v';
        const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

        const MEDICINE_CATEGORIES = [
            { id: 'ALL', label: 'All Categories', icon: 'fa-border-all' },
            { id: 'Tablet / Pill', label: 'Tablet / Pill', icon: 'fa-tablets' },
            { id: 'Capsule', label: 'Capsule', icon: 'fa-capsules' },
            { id: 'Syrup / Suspension', label: 'Syrup / Suspension', icon: 'fa-prescription-bottle' },
            { id: 'Injection / Vial', label: 'Injection / Vial', icon: 'fa-syringe' },
            { id: 'Cream / Ointment', label: 'Cream / Ointment', icon: 'fa-pump-medical' },
            { id: 'Inhaler / Drops', label: 'Inhaler / Drops', icon: 'fa-lungs' }
        ];

        // ---------------------------------------------------------
        // 2. GLOBAL STATE, PASSWORD ENCRYPTION & IN-MEMORY LOCATION
        // ---------------------------------------------------------
        let mediRadarCart = [];
        let currentCustomer = JSON.parse(localStorage.getItem('mediradar_customer') || 'null');

        // Customer password encryption helpers (Matches PharmaConnect security standard)
        const CUST_SECRET_KEY = "MR_CUST_2026_";
        function encryptCustomerPassword(rawPwd) {
            return btoa(CUST_SECRET_KEY + rawPwd).split('').reverse().join('');
        }
        function decryptCustomerPassword(encPwd) {
            try {
                const decoded = atob(encPwd.split('').reverse().join(''));
                if (decoded.startsWith(CUST_SECRET_KEY)) {
                    return decoded.replace(CUST_SECRET_KEY, '');
                }
                return encPwd;
            } catch (e) {
                return encPwd;
            }
        }

        let pharmaciesTable = [];
        let pharmacyBanksTable = [];
        let medicinesTable = [];
        let grnStockTable = [];
        let salesTransactionsTable = [];
        let myCustomerOrders = [];
        let knownOrderStatuses = {};
        let checkoutItemsQueue = [];
        let orderRealtimeChannel = null;

        // Strictly temporary in-memory location for the current browser tab only (Never saved to DB or shared)
        let userLocation = {
            lat: 6.79652,
            lng: 79.90053,
            label: "Default Location (Click Fetch Location)",
            isLiveGps: false
        };

        let selectedCategory = 'ALL';
        let sidebarOpen = window.innerWidth >= 1024; // Collapsed by default on mobile phones!
        let selectedPaymentMethod = 'BANK'; // Bank Transaction suggested first by default
        let postAuthCallback = null;

        // Automatically purge bank receipt images older than 24 hours from Supabase Storage & Orders
        async function cleanupExpiredBankReceipts() {
            try {
                // 1. Trigger SQL RPC cleanup if available
                await supabaseClient.rpc('cleanup_expired_bank_receipts');
            } catch ( _ ) {}

            try {
                // 2. Client-side Storage & URL cleanup for orders > 24 hours old
                const cutoffIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
                const { data: expiredOrders } = await supabaseClient
                    .from('customer_orders')
                    .select('id, receipt_image_url')
                    .not('receipt_image_url', 'is', null)
                    .lt('created_at', cutoffIso);

                if (expiredOrders && expiredOrders.length > 0) {
                    const filesToDelete = [];
                    expiredOrders.forEach(o => {
                        if (o.receipt_image_url && o.receipt_image_url.includes('/bank_receipts/')) {
                            const fileName = o.receipt_image_url.split('/bank_receipts/').pop().split('?')[0];
                            if (fileName) filesToDelete.push(fileName);
                        }
                    });

                    if (filesToDelete.length > 0) {
                        await supabaseClient.storage.from('bank_receipts').remove(filesToDelete);
                    }

                    const expiredIds = expiredOrders.map(o => o.id);
                    await supabaseClient
                        .from('customer_orders')
                        .update({ receipt_image_url: null })
                        .in('id', expiredIds);
                }
            } catch (e) {
                console.warn("24h receipt cleanup check:", e);
            }
        }

        // ---------------------------------------------------------
        // 3. FETCH LIVE DATA FROM SUPABASE
        // ---------------------------------------------------------
        async function fetchLiveSupabaseData() {
            const statusDot = document.getElementById('dbStatusDot');
            const statusText = document.getElementById('dbStatusText');
            statusText.textContent = "Syncing Supabase...";

            try {
                cleanupExpiredBankReceipts();

                const [pharmRes, banksRes, medRes, stockRes, salesRes] = await Promise.all([
                    supabaseClient.from('pharmacies').select('*'),
                    supabaseClient.from('pharmacy_banks').select('*'),
                    supabaseClient.from('medicines').select('*'),
                    supabaseClient.from('grn_stock').select('*'),
                    supabaseClient.from('sales_transactions').select('*').order('sold_at', { ascending: false }).limit(50)
                ]);

                if (pharmRes.error) throw pharmRes.error;
                if (medRes.error) throw medRes.error;
                if (stockRes.error) throw stockRes.error;

                pharmaciesTable = pharmRes.data || [];
                pharmacyBanksTable = banksRes.data || [];
                medicinesTable = medRes.data || [];
                grnStockTable = stockRes.data || [];
                if (salesRes.data) salesTransactionsTable = salesRes.data;

                statusDot.className = "w-2 h-2 rounded-full bg-emerald-400 animate-pulse flex-shrink-0";
                statusText.textContent = `Live DB (${pharmaciesTable.length} Pharmacies, ${grnStockTable.length} Stock)`;

                populateDynamicFilterDropdowns();
                renderCategorySidebar();
                applyFiltersAndRender();
                renderPharmaciesDirectory();

                if (currentCustomer) {
                    await loadCustomerCartFromSupabase();
                    await fetchMyCustomerOrders(true);
                } else {
                    mediRadarCart = [];
                    updateCartBadges();
                }
            } catch (err) {
                console.error("Supabase Fetch Error:", err);
                statusDot.className = "w-2 h-2 rounded-full bg-rose-500 flex-shrink-0";
                statusText.textContent = "Database Connection Error";
            }
        }

        function populateDynamicFilterDropdowns() {
            const citySelect = document.getElementById('cityFilter');
            const supplierSelect = document.getElementById('supplierFilter');
            const priceSlider = document.getElementById('priceFilter');

            const currentCity = citySelect.value || 'ALL';
            const currentSupplier = supplierSelect.value || 'ALL';

            const cities = [...new Set(pharmaciesTable.map(p => (p.city || '').trim()).filter(Boolean))].sort();
            citySelect.innerHTML = `<option value="ALL">All Cities (${cities.length})</option>` +
                cities.map(c => `<option value="${c}">${c}</option>`).join('');
            if (cities.includes(currentCity)) citySelect.value = currentCity;

            const suppliers = [...new Set(grnStockTable.map(s => (s.supplier_name || '').trim()).filter(Boolean))].sort();
            supplierSelect.innerHTML = `<option value="ALL">All Verified Suppliers (${suppliers.length})</option>` +
                suppliers.map(s => `<option value="${s}">${s}</option>`).join('');
            if (suppliers.includes(currentSupplier)) supplierSelect.value = currentSupplier;

            const prices = grnStockTable.map(s => parseFloat(s.selling_price || 0)).filter(p => !isNaN(p) && p > 0);
            const highestDbPrice = prices.length > 0 ? Math.max(...prices) : 25000;
            const sliderMax = Math.max(25000, Math.ceil(highestDbPrice / 1000) * 1000);
            priceSlider.max = sliderMax;
            priceSlider.value = sliderMax;
            updatePriceLabel();
        }

        // ---------------------------------------------------------
        // 4. PERSISTENT DATABASE CART (`customer_cart_items` TABLE)
        //    Requires Sign-In to Add to Cart; Persists Across Logouts
        // ---------------------------------------------------------
        function updateCartBadges() {
            const totalItems = mediRadarCart.reduce((sum, i) => sum + Number(i.qty || 1), 0);
            document.getElementById('cartCountBadge').textContent = totalItems;
            const sideBadge = document.getElementById('sidebarCartBadge');
            if (sideBadge) sideBadge.textContent = totalItems;
        }

        async function loadCustomerCartFromSupabase() {
            if (!currentCustomer || !currentCustomer.id) {
                mediRadarCart = [];
                updateCartBadges();
                return;
            }

            try {
                const { data, error } = await supabaseClient
                    .from('customer_cart_items')
                    .select('*')
                    .eq('customer_id', currentCustomer.id)
                    .order('created_at', { ascending: true });

                if (error) throw error;

                mediRadarCart = (data || []).map(row => {
                    const stockRow = grnStockTable.find(s => String(s.id) === String(row.grn_stock_id));
                    const pharm = pharmaciesTable.find(p => String(p.id) === String(row.pharmacy_id)) || {
                        id: row.pharmacy_id,
                        pharmacy_name: "Registered Pharmacy",
                        city: "Sri Lanka"
                    };

                    const maxStock = stockRow ? parseInt(stockRow.current_quantity || 0, 10) : row.quantity;
                    return {
                        cart_row_id: row.id,
                        stock_id: row.grn_stock_id,
                        medicine_id: row.medicine_id || (stockRow ? stockRow.medicine_id : null),
                        medicine_name: row.medicine_name || (stockRow ? stockRow.medicine_name : 'Medicine'),
                        pharmacy_id: row.pharmacy_id,
                        pharmacy_name: pharm.pharmacy_name,
                        pharmacy_city: pharm.city || '',
                        unit_price: stockRow ? parseFloat(stockRow.selling_price || row.unit_price) : parseFloat(row.unit_price || 0),
                        unit_cost: stockRow ? parseFloat(stockRow.unit_cost || 0) : 0,
                        max_stock: maxStock,
                        batch_number: stockRow ? (stockRow.batch_number || 'N/A') : 'N/A',
                        rack_location: stockRow ? (stockRow.rack_location || 'Main Shelf') : 'Main Shelf',
                        qty: Math.min(row.quantity, Math.max(1, maxStock))
                    };
                }).filter(item => item.max_stock > 0);

                updateCartBadges();
            } catch (err) {
                console.warn("Could not load customer cart from Supabase:", err);
            }
        }

        async function addToCart(grnStockId, qtyToAdd = 1, openCartAfter = false) {
            // Require customer to Sign In / Register before adding to cart
            if (!currentCustomer) {
                showToast("Sign In Required", "Please sign in or register an account to save medicines to your cart.");
                postAuthCallback = () => addToCart(grnStockId, qtyToAdd, openCartAfter);
                openCustomerAccountModal();
                return;
            }

            const stockRow = grnStockTable.find(s => String(s.id) === String(grnStockId));
            if (!stockRow) return;

            const pharm = pharmaciesTable.find(p => p.id === stockRow.pharmacy_id) || {
                id: stockRow.pharmacy_id,
                pharmacy_name: "Registered Pharmacy",
                city: "Sri Lanka"
            };

            const existingIndex = mediRadarCart.findIndex(item => String(item.stock_id) === String(grnStockId));
            let targetQty = qtyToAdd;

            if (existingIndex > -1) {
                targetQty = mediRadarCart[existingIndex].qty + qtyToAdd;
                if (targetQty > Number(stockRow.current_quantity)) {
                    showToast("Stock Limit Reached", `Only ${stockRow.current_quantity} units available in ${pharm.pharmacy_name}.`);
                    return;
                }
                mediRadarCart[existingIndex].qty = targetQty;
            } else {
                mediRadarCart.push({
                    stock_id: stockRow.id,
                    medicine_id: stockRow.medicine_id,
                    medicine_name: stockRow.medicine_name,
                    pharmacy_id: pharm.id,
                    pharmacy_name: pharm.pharmacy_name,
                    pharmacy_city: pharm.city || '',
                    unit_price: parseFloat(stockRow.selling_price || 0),
                    unit_cost: parseFloat(stockRow.unit_cost || 0),
                    max_stock: parseInt(stockRow.current_quantity || 1, 10),
                    batch_number: stockRow.batch_number || 'N/A',
                    rack_location: stockRow.rack_location || 'Main Shelf',
                    qty: targetQty
                });
            }

            updateCartBadges();

            // Persist in Supabase `customer_cart_items`
            try {
                await supabaseClient
                    .from('customer_cart_items')
                    .upsert([{
                        customer_id: currentCustomer.id,
                        grn_stock_id: stockRow.id,
                        medicine_id: stockRow.medicine_id || null,
                        pharmacy_id: pharm.id,
                        medicine_name: stockRow.medicine_name,
                        quantity: targetQty,
                        unit_price: parseFloat(stockRow.selling_price || 0)
                    }], { onConflict: 'customer_id,grn_stock_id' });
            } catch (e) {
                console.warn("Cart DB sync error:", e);
            }

            showToast("Saved to Your Cart", `${stockRow.medicine_name} (${pharm.pharmacy_name}) saved to your account cart.`);
            if (openCartAfter) {
                closeNearestModal();
                openCartModal();
            }
        }

        async function removeFromCart(index) {
            if (index < 0 || index >= mediRadarCart.length) return;
            const removed = mediRadarCart.splice(index, 1)[0];
            updateCartBadges();
            renderCartModalItems();

            if (removed && currentCustomer) {
                try {
                    await supabaseClient
                        .from('customer_cart_items')
                        .delete()
                        .eq('customer_id', currentCustomer.id)
                        .eq('grn_stock_id', removed.stock_id);
                } catch (e) {
                    console.warn("Remove cart item DB error:", e);
                }
                showToast("Removed from Cart", `${removed.medicine_name} removed from your cart.`);
            }
        }

        async function updateCartQty(index, delta) {
            const item = mediRadarCart[index];
            if (!item) return;
            const nextQty = item.qty + delta;
            if (nextQty <= 0) {
                await removeFromCart(index);
                return;
            }
            if (nextQty > item.max_stock) {
                showToast("Max Stock", `Only ${item.max_stock} units available.`);
                return;
            }
            item.qty = nextQty;
            updateCartBadges();
            renderCartModalItems();

            if (currentCustomer) {
                try {
                    await supabaseClient
                        .from('customer_cart_items')
                        .update({ quantity: nextQty })
                        .eq('customer_id', currentCustomer.id)
                        .eq('grn_stock_id', item.stock_id);
                } catch (e) {
                    console.warn("Cart qty DB update error:", e);
                }
            }
        }

        async function clearEntireCart() {
            mediRadarCart = [];
            updateCartBadges();
            renderCartModalItems();

            if (currentCustomer) {
                try {
                    await supabaseClient
                        .from('customer_cart_items')
                        .delete()
                        .eq('customer_id', currentCustomer.id);
                } catch (e) {
                    console.warn("Clear cart DB error:", e);
                }
            }
        }

        function openCartModal() {
            if (!currentCustomer) {
                showToast("Sign In Required", "Please sign in to view your saved shopping cart.");
                postAuthCallback = () => openCartModal();
                openCustomerAccountModal();
                return;
            }
            renderCartModalItems();
            document.getElementById('cartModal').classList.remove('hidden');
        }

        function closeCartModal() {
            document.getElementById('cartModal').classList.add('hidden');
        }

        function renderCartModalItems() {
            const container = document.getElementById('cartItemsContainer');
            const totalEl = document.getElementById('cartTotalDisplay');

            if (mediRadarCart.length === 0) {
                container.innerHTML = `
                    <div class="text-center py-10 text-slate-400">
                        <i class="fa-solid fa-cart-shopping text-3xl mb-2"></i>
                        <p class="text-sm font-semibold text-slate-600">Your MediRadar Cart is empty.</p>
                        <p class="text-xs text-slate-400 mt-1">Items you add while signed in are saved to your account until bought.</p>
                    </div>
                `;
                totalEl.textContent = "Rs. 0.00";
                return;
            }

            let grandTotal = 0;
            container.innerHTML = mediRadarCart.map((item, index) => {
                const lineTotal = item.qty * item.unit_price;
                grandTotal += lineTotal;
                return `
                    <div class="bg-white p-4 rounded-2xl border border-slate-200 shadow-sm flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                        <div>
                            <span class="text-[10px] font-extrabold uppercase px-2 py-0.5 rounded bg-teal-50 text-teal-700 border border-teal-200">
                                <i class="fa-solid fa-store mr-1"></i>${item.pharmacy_name} (${item.pharmacy_city})
                            </span>
                            <h4 class="text-sm font-extrabold text-slate-900 mt-1">${item.medicine_name}</h4>
                            <p class="text-xs text-slate-500">Batch: ${item.batch_number} • Rs. ${item.unit_price.toFixed(2)} / unit</p>
                        </div>

                        <div class="flex items-center justify-between sm:justify-end gap-3">
                            <div class="flex items-center gap-1.5 bg-slate-100 px-2 py-1 rounded-xl">
                                <button type="button" onclick="updateCartQty(${index}, -1)" class="w-6 h-6 rounded-lg bg-white font-bold text-slate-700 shadow-sm">-</button>
                                <span class="w-8 text-center text-xs font-extrabold">${item.qty}</span>
                                <button type="button" onclick="updateCartQty(${index}, 1)" class="w-6 h-6 rounded-lg bg-white font-bold text-slate-700 shadow-sm">+</button>
                            </div>

                            <div class="text-right min-w-[90px]">
                                <span class="text-sm font-extrabold text-slate-900">Rs. ${lineTotal.toFixed(2)}</span>
                            </div>

                            <button type="button" onclick="removeFromCart(${index})"
                                class="px-3 py-1.5 rounded-xl bg-rose-50 hover:bg-rose-100 text-rose-600 border border-rose-200 text-xs font-bold transition">
                                <i class="fa-solid fa-trash-can mr-1"></i>Remove
                            </button>
                        </div>
                    </div>
                `;
            }).join('');

            totalEl.textContent = `Rs. ${grandTotal.toFixed(2)}`;
        }

        function proceedFromCartToCheckout() {
            if (mediRadarCart.length === 0) {
                showToast("Cart Empty", "Please add at least one medicine to your cart first.");
                return;
            }
            closeCartModal();
            initiateCheckoutFlow([...mediRadarCart], true);
        }

        function buySingleStockItemNow(grnStockId) {
            const stockRow = grnStockTable.find(s => String(s.id) === String(grnStockId));
            if (!stockRow) return;
            const pharm = pharmaciesTable.find(p => p.id === stockRow.pharmacy_id) || {
                id: stockRow.pharmacy_id,
                pharmacy_name: "Registered Pharmacy",
                city: "Sri Lanka"
            };

            const singleItem = [{
                stock_id: stockRow.id,
                medicine_id: stockRow.medicine_id,
                medicine_name: stockRow.medicine_name,
                pharmacy_id: pharm.id,
                pharmacy_name: pharm.pharmacy_name,
                pharmacy_city: pharm.city || '',
                unit_price: parseFloat(stockRow.selling_price || 0),
                unit_cost: parseFloat(stockRow.unit_cost || 0),
                max_stock: parseInt(stockRow.current_quantity || 1, 10),
                batch_number: stockRow.batch_number || 'N/A',
                rack_location: stockRow.rack_location || 'Main Shelf',
                qty: 1
            }];

            closeNearestModal();
            initiateCheckoutFlow(singleItem, false);
        }

        // ---------------------------------------------------------
        // 5. CUSTOMER REGISTRATION & LOGIN (ENCRYPTED PASSWORD, NO CARD/GPS SAVED)
        // ---------------------------------------------------------
        function updateCustomerHeaderUI() {
            const label = document.getElementById('headerAccountLabel');
            const logoutBtn = document.getElementById('logoutCustomerBtn');
            const headerSignOutBtn = document.getElementById('headerSignOutBtn');

            if (currentCustomer) {
                label.textContent = currentCustomer.full_name || currentCustomer.email;
                if (logoutBtn) logoutBtn.classList.remove('hidden');
                if (headerSignOutBtn) headerSignOutBtn.classList.remove('hidden');
            } else {
                label.textContent = "Sign In / Register";
                if (logoutBtn) logoutBtn.classList.add('hidden');
                if (headerSignOutBtn) headerSignOutBtn.classList.add('hidden');
            }
        }

        function openCustomerAccountModal() {
            const modal = document.getElementById('customerAccountModal');
            if (currentCustomer) {
                switchAuthTab('REGISTER');
                document.getElementById('accountModalTitle').textContent = "Edit Your Customer Profile & Bank Defaults";
                document.getElementById('saveProfileSubmitBtn').textContent = "Update My Profile";
                document.getElementById('profFullName').value = currentCustomer.full_name || '';
                document.getElementById('profEmail').value = currentCustomer.email || '';
                document.getElementById('profPassword').value = decryptCustomerPassword(currentCustomer.password || '');
                document.getElementById('profPhone').value = currentCustomer.phone || '';
                document.getElementById('profAddress').value = currentCustomer.address || '';
                document.getElementById('profBankName').value = currentCustomer.bank_name || '';
                document.getElementById('profBankAccountNo').value = currentCustomer.bank_account_no || '';
            } else {
                document.getElementById('customerProfileForm').reset();
                document.getElementById('accountModalTitle').textContent = "Register Customer Account";
                document.getElementById('saveProfileSubmitBtn').textContent = "Complete Customer Registration";
                switchAuthTab('REGISTER');
            }
            modal.classList.remove('hidden');
        }

        function closeCustomerAccountModal() {
            document.getElementById('customerAccountModal').classList.add('hidden');
        }

        function switchAuthTab(mode) {
            const regForm = document.getElementById('customerProfileForm');
            const loginForm = document.getElementById('customerLoginForm');
            const tabReg = document.getElementById('tabRegisterMode');
            const tabLog = document.getElementById('tabLoginMode');

            if (mode === 'LOGIN') {
                regForm.classList.add('hidden');
                loginForm.classList.remove('hidden');
                tabLog.className = "flex-1 py-2 rounded-xl text-xs font-extrabold bg-white text-slate-900 shadow-sm transition";
                tabReg.className = "flex-1 py-2 rounded-xl text-xs font-bold text-slate-600 hover:text-slate-900 transition";
            } else {
                loginForm.classList.add('hidden');
                regForm.classList.remove('hidden');
                tabReg.className = "flex-1 py-2 rounded-xl text-xs font-extrabold bg-white text-slate-900 shadow-sm transition";
                tabLog.className = "flex-1 py-2 rounded-xl text-xs font-bold text-slate-600 hover:text-slate-900 transition";
            }
        }

        async function handleSaveCustomerProfile(event) {
            event.preventDefault();
            const btn = document.getElementById('saveProfileSubmitBtn');
            btn.disabled = true;
            btn.textContent = "Saving to Supabase...";

            const rawPassword = document.getElementById('profPassword').value.trim();
            const encryptedPassword = encryptCustomerPassword(rawPassword);

            // Notice: No card details and no GPS coordinates are ever stored in Supabase
            const payload = {
                full_name: document.getElementById('profFullName').value.trim(),
                email: document.getElementById('profEmail').value.trim().toLowerCase(),
                password: encryptedPassword,
                phone: document.getElementById('profPhone').value.trim(),
                address: document.getElementById('profAddress').value.trim(),
                bank_name: document.getElementById('profBankName').value,
                bank_account_no: document.getElementById('profBankAccountNo').value.trim()
            };

            try {
                let savedRow = null;
                if (currentCustomer && currentCustomer.id) {
                    const { data, error } = await supabaseClient
                        .from('customers')
                        .update(payload)
                        .eq('id', currentCustomer.id)
                        .select()
                        .single();
                    if (error) throw error;
                    savedRow = data;
                } else {
                    const { data: existing } = await supabaseClient
                        .from('customers')
                        .select('*')
                        .eq('email', payload.email)
                        .maybeSingle();

                    if (existing) {
                        throw new Error("An account with this email already exists. Please use the 'Returning Customer Sign In' tab.");
                    } else {
                        const { data, error } = await supabaseClient
                            .from('customers')
                            .insert([payload])
                            .select()
                            .single();
                        if (error) throw error;
                        savedRow = data;
                    }
                }

                currentCustomer = savedRow;
                localStorage.setItem('mediradar_customer', JSON.stringify(currentCustomer));
                updateCustomerHeaderUI();
                subscribeToCustomerOrderUpdates();
                await loadCustomerCartFromSupabase();
                await fetchMyCustomerOrders(true);
                closeCustomerAccountModal();
                showToast("Account Saved", `Welcome ${currentCustomer.full_name}!`);

                if (typeof postAuthCallback === 'function') {
                    const cb = postAuthCallback;
                    postAuthCallback = null;
                    cb();
                }
            } catch (err) {
                console.error("Customer Save Error:", err);
                showToast("Account Notice", err.message || "Could not save customer profile.");
            } finally {
                btn.disabled = false;
                btn.textContent = "Save Customer Account";
            }
        }

        async function handleCustomerLogin(event) {
            event.preventDefault();
            const email = document.getElementById('loginEmailInput').value.trim().toLowerCase();
            const rawPass = document.getElementById('loginPasswordInput').value.trim();
            const encPass = encryptCustomerPassword(rawPass);

            try {
                const { data, error } = await supabaseClient
                    .from('customers')
                    .select('*')
                    .eq('email', email)
                    .maybeSingle();

                if (error) throw error;

                // Match encrypted password (or legacy plain password if created before encryption)
                if (!data || (data.password !== encPass && data.password !== rawPass)) {
                    showToast("Sign In Failed", "Invalid email or password.");
                    return;
                }

                // Upgrade legacy plaintext password to encrypted automatically on login
                if (data.password === rawPass && data.password !== encPass) {
                    await supabaseClient.from('customers').update({ password: encPass }).eq('id', data.id);
                    data.password = encPass;
                }

                currentCustomer = data;
                localStorage.setItem('mediradar_customer', JSON.stringify(currentCustomer));
                updateCustomerHeaderUI();
                subscribeToCustomerOrderUpdates();
                await loadCustomerCartFromSupabase();
                await fetchMyCustomerOrders(true);
                closeCustomerAccountModal();
                showToast("Signed In!", `Welcome back, ${currentCustomer.full_name}. Your saved cart items have been restored.`);

                if (typeof postAuthCallback === 'function') {
                    const cb = postAuthCallback;
                    postAuthCallback = null;
                    cb();
                }
            } catch (err) {
                showToast("Login Error", err.message);
            }
        }

        function logoutCustomer() {
            currentCustomer = null;
            myCustomerOrders = [];
            mediRadarCart = []; // Clear local view; items remain safely in `customer_cart_items` table for next login
            localStorage.removeItem('mediradar_customer');
            updateCustomerHeaderUI();
            updateCartBadges();
            updateOrdersBadge();
            closeCustomerAccountModal();
            showToast("Signed Out", "Your unbought cart items are safely saved in your account for your next sign-in.");
        }

        // ---------------------------------------------------------
        // 6. CHECKOUT FLOW (BANK FIRST, TEMPORARY CARD INPUT, CART CLEANUP)
        // ---------------------------------------------------------
        let isCheckingOutFromCart = false;

        function initiateCheckoutFlow(itemsToBuy, fromCart = false) {
            if (!currentCustomer) {
                showToast("Registration Required", "Please register or sign in before purchasing medicines online.");
                postAuthCallback = () => initiateCheckoutFlow(itemsToBuy, fromCart);
                openCustomerAccountModal();
                return;
            }

            checkoutItemsQueue = itemsToBuy;
            isCheckingOutFromCart = fromCart;

            renderCheckoutSummary();

            document.getElementById('custName').value = currentCustomer.full_name || '';
            document.getElementById('custPhone').value = currentCustomer.phone || '';
            document.getElementById('custAddress').value = currentCustomer.address || '';

            // Always start card inputs blank (temporary per-transaction only, never stored)
            document.getElementById('cardNumberInput').value = '';
            document.getElementById('cardExpiryInput').value = '';
            document.getElementById('cardCvvInput').value = '';

            document.getElementById('bankNameSelect').value =
                `${currentCustomer.bank_name || ''} - Acc: ${currentCustomer.bank_account_no || ''}`;

            const uniquePharmIds = [...new Set(itemsToBuy.map(i => i.pharmacy_id))];
            renderCheckoutPharmacyBankDetails(uniquePharmIds);

            // Suggest Bank Transaction first by default
            selectPaymentMethod('BANK');
            document.getElementById('checkoutModal').classList.remove('hidden');
        }

        function renderCheckoutSummary() {
            const uniquePharmIds = [...new Set(checkoutItemsQueue.map(i => i.pharmacy_id))];
            const pharmNames = uniquePharmIds.map(pid => {
                const p = pharmaciesTable.find(ph => ph.id === pid);
                return p ? `${p.pharmacy_name} (${p.city || ''})` : 'Registered Pharmacy';
            });

            document.getElementById('checkoutPharmacyName').textContent = pharmNames.join(' + ');
            document.getElementById('checkoutItemsCountBadge').textContent = `${checkoutItemsQueue.reduce((s, i) => s + i.qty, 0)} Unit(s)`;

            const itemsListEl = document.getElementById('checkoutOrderItemsList');
            let total = 0;
            
            itemsListEl.innerHTML = checkoutItemsQueue.map((item, index) => {
                const line = item.qty * item.unit_price;
                total += line;
                return `
                    <div class="flex items-center justify-between bg-white p-2 rounded-lg border border-teal-100 mb-1.5 shadow-sm">
                        <div class="flex flex-col">
                            <span class="font-bold text-slate-800">${item.medicine_name}</span>
                            <span class="text-[10px] text-slate-500">${item.pharmacy_name} • Rs. ${item.unit_price.toFixed(2)}</span>
                        </div>
                        <div class="flex items-center gap-3">
                            <div class="flex items-center gap-1 bg-slate-100 px-1.5 py-1 rounded-lg">
                                <button type="button" onclick="updateCheckoutItemQty(${index}, -1)" class="w-6 h-6 rounded-md bg-white font-bold text-slate-700 shadow-sm leading-none flex items-center justify-center">-</button>
                                <span class="w-6 text-center text-xs font-extrabold">${item.qty}</span>
                                <button type="button" onclick="updateCheckoutItemQty(${index}, 1)" class="w-6 h-6 rounded-md bg-white font-bold text-slate-700 shadow-sm leading-none flex items-center justify-center">+</button>
                            </div>
                            <span class="font-bold text-slate-900 w-16 text-right">Rs. ${line.toFixed(2)}</span>
                        </div>
                    </div>
                `;
            }).join('');
            
            document.getElementById('checkoutTotalAmount').textContent = `Rs. ${total.toFixed(2)}`;
        }

        async function updateCheckoutItemQty(index, delta) {
            const item = checkoutItemsQueue[index];
            if (!item) return;

            const nextQty = item.qty + delta;
            if (nextQty < 1) return; 
            
            if (nextQty > item.max_stock) {
                showToast("Max Stock", `Only ${item.max_stock} units available.`);
                return;
            }

            item.qty = nextQty;
            
            if (isCheckingOutFromCart && currentCustomer) {
                updateCartBadges();
                renderCartModalItems();
                await supabaseClient
                    .from('customer_cart_items')
                    .update({ quantity: nextQty })
                    .eq('customer_id', currentCustomer.id)
                    .eq('grn_stock_id', item.stock_id);
            }
            
            renderCheckoutSummary();
        }

        function renderCheckoutPharmacyBankDetails(pharmacyIds) {
            const container = document.getElementById('checkoutPharmacyBanksList');
            const blocks = [];

            pharmacyIds.forEach(pid => {
                const pharm = pharmaciesTable.find(p => p.id === pid);
                const multiBanks = pharmacyBanksTable.filter(b => b.pharmacy_id === pid);

                if (multiBanks.length > 0) {
                    multiBanks.forEach(b => {
                        blocks.push(`
                            <div class="bg-white p-3 rounded-xl border border-teal-200 text-xs space-y-0.5">
                                <div class="font-extrabold text-teal-900">${pharm ? pharm.pharmacy_name : 'Pharmacy'} — ${b.bank_name} (${b.branch_name || 'Main Branch'})</div>
                                <div class="text-slate-600">Account Name: <strong>${b.account_name}</strong></div>
                                <div class="text-slate-600">Account Number: <strong class="font-mono text-brand-700">${b.account_number}</strong></div>
                            </div>
                        `);
                    });
                } else if (pharm && (pharm.bank_name || pharm.account_number)) {
                    blocks.push(`
                        <div class="bg-white p-3 rounded-xl border border-teal-200 text-xs space-y-0.5">
                            <div class="font-extrabold text-teal-900">${pharm.pharmacy_name} — ${pharm.bank_name || 'Commercial Bank'} (${pharm.bank_branch || pharm.city || 'Main Branch'})</div>
                            <div class="text-slate-600">Account Name: <strong>${pharm.account_name || pharm.pharmacy_name}</strong></div>
                            <div class="text-slate-600">Account Number: <strong class="font-mono text-brand-700">${pharm.account_number || 'Contact Pharmacy'}</strong></div>
                        </div>
                    `);
                } else {
                    blocks.push(`
                        <div class="bg-white p-3 rounded-xl border border-slate-200 text-xs space-y-0.5">
                            <div class="font-extrabold text-slate-800">${pharm ? pharm.pharmacy_name : 'Pharmacy'} Official Account</div>
                            <div class="text-slate-500">Phone: ${pharm ? pharm.phone : 'N/A'} • Transfer & upload receipt slip below for Cashier verification.</div>
                        </div>
                    `);
                }
            });

            container.innerHTML = blocks.join('');
        }

        function closeCheckoutModal() {
            // Wipe temporary card inputs immediately when modal closes
            document.getElementById('cardNumberInput').value = '';
            document.getElementById('cardExpiryInput').value = '';
            document.getElementById('cardCvvInput').value = '';
            document.getElementById('checkoutModal').classList.add('hidden');
        }

        function handleReceiptSelection(event) {
            const removeBtn = document.getElementById('remove-receipt-btn');
            if (event.target.files && event.target.files.length > 0) {
                removeBtn.classList.remove('hidden');
            } else {
                removeBtn.classList.add('hidden');
            }
        }

        function clearReceiptUpload() {
            const fileInput = document.getElementById('receipt-upload');
            const removeBtn = document.getElementById('remove-receipt-btn');
            fileInput.value = '';
            removeBtn.classList.add('hidden');
        }

        function selectPaymentMethod(method) {
            selectedPaymentMethod = method;
            const tabCard = document.getElementById('payTabCard');
            const tabBank = document.getElementById('payTabBank');
            const cardSec = document.getElementById('cardPaymentSection');
            const bankSec = document.getElementById('bankPaymentSection');

            if (method === 'BANK') {
                tabBank.className = "p-3.5 rounded-2xl border-2 border-brand-600 bg-brand-50/60 text-left transition flex items-center gap-3 relative";
                tabCard.className = "p-3.5 rounded-2xl border-2 border-slate-200 hover:border-slate-300 bg-white text-left transition flex items-center gap-3";
                bankSec.classList.remove('hidden');
                cardSec.classList.add('hidden');
            } else {
                tabCard.className = "p-3.5 rounded-2xl border-2 border-brand-600 bg-brand-50/60 text-left transition flex items-center gap-3";
                tabBank.className = "p-3.5 rounded-2xl border-2 border-slate-200 hover:border-slate-300 bg-white text-left transition flex items-center gap-3 relative";
                cardSec.classList.remove('hidden');
                bankSec.classList.add('hidden');
            }
        }

        async function submitPharmacyOrder(event) {
            event.preventDefault();
            if (!currentCustomer || checkoutItemsQueue.length === 0) return;

            const custName = document.getElementById('custName').value.trim();
            const custPhone = document.getElementById('custPhone').value.trim();
            const custAddress = document.getElementById('custAddress').value.trim();
            const cardNo = document.getElementById('cardNumberInput').value.replace(/\s+/g, '').trim();
            const cardExp = document.getElementById('cardExpiryInput').value.trim();
            const cardCvv = document.getElementById('cardCvvInput').value.trim();
            const sendingBank = document.getElementById('bankNameSelect').value.trim();
            const bankRef = document.getElementById('bankRefInput').value.trim();
            const receiptFileInput = document.getElementById('receipt-upload');

            const submitBtn = document.getElementById('submitOrderBtn');
            submitBtn.disabled = true;
            submitBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Processing Order...`;

            try {
                let uploadedReceiptUrl = null;

                if (selectedPaymentMethod === 'CARD') {
                    if (cardNo.length < 12 || !cardExp || cardCvv.length < 3) {
                        throw new Error("Please enter valid temporary Card Number, Expiry Date, and CVV to process this transaction.");
                    }
                } else {
                    if (!bankRef) {
                        throw new Error("Please enter your Bank Transfer Reference / Slip Number.");
                    }
                    if (!receiptFileInput.files || receiptFileInput.files.length === 0) {
                        throw new Error("Please upload a screenshot/photo of your bank transfer receipt.");
                    }

                    const file = receiptFileInput.files[0];
                    const ext = (file.name.split('.').pop() || 'png').toLowerCase();
                    const filePath = `receipt_${currentCustomer.id}_${Date.now()}.${ext}`;

                    const { error: upErr } = await supabaseClient
                        .storage
                        .from('bank_receipts')
                        .upload(filePath, file, { cacheControl: '3600', upsert: true });

                    if (upErr) throw new Error(`Receipt Upload Failed: ${upErr.message}`);

                    const { data: pubUrlData } = supabaseClient
                        .storage
                        .from('bank_receipts')
                        .getPublicUrl(filePath);

                    uploadedReceiptUrl = pubUrlData.publicUrl;
                }

                // Only save non-sensitive delivery details (never save card numbers or GPS location!)
                if (document.getElementById('saveChangesToProfileCheckbox').checked) {
                    const updatedProfile = {
                        full_name: custName,
                        phone: custPhone,
                        address: custAddress
                    };
                    const { data: profData } = await supabaseClient
                        .from('customers')
                        .update(updatedProfile)
                        .eq('id', currentCustomer.id)
                        .select()
                        .maybeSingle();
                    if (profData) {
                        currentCustomer = profData;
                        localStorage.setItem('mediradar_customer', JSON.stringify(currentCustomer));
                        updateCustomerHeaderUI();
                    }
                }

                const itemsByPharmacy = {};
                checkoutItemsQueue.forEach(item => {
                    if (!itemsByPharmacy[item.pharmacy_id]) itemsByPharmacy[item.pharmacy_id] = [];
                    itemsByPharmacy[item.pharmacy_id].push(item);
                });

                for (const pharmacyId of Object.keys(itemsByPharmacy)) {
                    const pharmItems = itemsByPharmacy[pharmacyId];
                    const orderTotal = pharmItems.reduce((sum, i) => sum + (i.qty * i.unit_price), 0);
                    const invoiceNo = `MR-${Math.floor(100000 + Math.random() * 900000)}`;
                    const isCard = selectedPaymentMethod === 'CARD';

                    const { data: insertedOrder, error: orderErr } = await supabaseClient
                        .from('customer_orders')
                        .insert([{
                            customer_id: currentCustomer.id,
                            pharmacy_id: pharmacyId,
                            invoice_no: invoiceNo,
                            total_amount: orderTotal,
                            payment_method: isCard ? 'Card' : 'Bank Transaction',
                            payment_status: isCard ? 'Paid' : 'Pending',
                            order_status: isCard ? 'Ready for Pickup' : 'Processing',
                            cashier_approval_status: isCard ? 'Accepted' : 'Pending',
                            delivery_address: custAddress,
                            customer_phone: custPhone,
                            customer_name: custName,
                            sending_bank: isCard ? `One-Time Card Payment` : sendingBank,
                            bank_reference: isCard ? `CARD-TXN` : bankRef,
                            receipt_image_url: uploadedReceiptUrl
                        }])
                        .select()
                        .single();

                    if (orderErr) throw orderErr;

                    knownOrderStatuses[insertedOrder.id] = insertedOrder.cashier_approval_status;

                    const orderItemsPayload = pharmItems.map(i => ({
                        order_id: insertedOrder.id,
                        medicine_id: i.medicine_id || null,
                        grn_stock_id: i.stock_id,
                        medicine_name: i.medicine_name,
                        quantity: i.qty,
                        unit_price: i.unit_price
                    }));

                    const { error: itemsErr } = await supabaseClient
                        .from('customer_order_items')
                        .insert(orderItemsPayload);

                    if (itemsErr) throw itemsErr;

                    if (isCard) {
                        for (const item of pharmItems) {
                            const stockRow = grnStockTable.find(s => String(s.id) === String(item.stock_id));
                            const newQty = stockRow ? Math.max(0, Number(stockRow.current_quantity) - item.qty) : 0;
                            if (stockRow) stockRow.current_quantity = newQty;

                            await supabaseClient
                                .from('grn_stock')
                                .update({ current_quantity: newQty })
                                .eq('id', item.stock_id);

                            await supabaseClient
                                .from('sales_transactions')
                                .insert([{
                                    pharmacy_id: pharmacyId,
                                    invoice_no: invoiceNo,
                                    counter_name: 'MediRadar Online (Card)',
                                    cashier_username: `${custName} (${custPhone})`,
                                    medicine_name: item.medicine_name,
                                    quantity_sold: item.qty,
                                    unit_cost: item.unit_cost,
                                    unit_price: item.unit_price,
                                    total_amount: item.qty * item.unit_price,
                                    profit_amount: item.qty * (item.unit_price - item.unit_cost)
                                }]);
                        }
                    }
                }

                // Remove purchased items from `customer_cart_items` table & local cart
                const boughtStockIds = checkoutItemsQueue.map(i => i.stock_id);
                await supabaseClient
                    .from('customer_cart_items')
                    .delete()
                    .eq('customer_id', currentCustomer.id)
                    .in('grn_stock_id', boughtStockIds);

                clearReceiptUpload();
                closeCheckoutModal();
                await fetchLiveSupabaseData();
                await fetchMyCustomerOrders(true);

                if (selectedPaymentMethod === 'BANK') {
                    showToast(
                        "Receipt Uploaded! Awaiting Cashier Approval",
                        "We will notify you here as soon as the pharmacy Cashier verifies your bank transfer."
                    );
                } else {
                    showToast(
                        "Card Payment Complete!",
                        "Your order is paid and card details were immediately discarded."
                    );
                }
            } catch (err) {
                console.error("Order Submit Error:", err);
                showToast("Checkout Error", err.message || "Could not submit order.");
            } finally {
                submitBtn.disabled = false;
                submitBtn.innerHTML = `<i class="fa-solid fa-circle-check"></i><span>Submit Pharmacy Order</span>`;
            }
        }

        // ---------------------------------------------------------
        // 7. CUSTOMER-ONLY ORDERS TABLE & LIVE CASHIER APPROVAL LISTENER
        // ---------------------------------------------------------
        async function fetchMyCustomerOrders(silent = false) {
            if (!currentCustomer) {
                myCustomerOrders = [];
                updateOrdersBadge();
                return;
            }

            try {
                const { data, error } = await supabaseClient
                    .from('customer_orders')
                    .select('*, customer_order_items(*)')
                    .eq('customer_id', currentCustomer.id)
                    .order('created_at', { ascending: false });

                if (error) throw error;

                const incomingOrders = data || [];

                // Check if any order's cashier_approval_status changed from Pending -> Accepted / Rejected
                incomingOrders.forEach(order => {
                    const prevStatus = knownOrderStatuses[order.id];
                    const newStatus = order.cashier_approval_status || 'Pending';

                    if (prevStatus && prevStatus !== newStatus) {
                        const pharm = pharmaciesTable.find(p => p.id === order.pharmacy_id);
                        const pharmName = pharm ? pharm.pharmacy_name : 'Pharmacy';
                        if (newStatus === 'Accepted') {
                            showToast(
                                `Payment Accepted by ${pharmName}!`,
                                `Your bank transfer for Invoice ${order.invoice_no || ''} (Rs. ${parseFloat(order.total_amount).toFixed(2)}) was verified and accepted by the Cashier!`
                            );
                        } else if (newStatus === 'Rejected') {
                            showToast(
                                `Payment Rejected by ${pharmName}`,
                                `Invoice ${order.invoice_no || ''} was rejected. Reason: ${order.rejection_reason || 'Invalid bank slip.'}`
                            );
                        }
                    }
                    knownOrderStatuses[order.id] = newStatus;
                });

                myCustomerOrders = incomingOrders;
                updateOrdersBadge();
                if (!silent) renderMyOrdersTable();
            } catch (err) {
                console.warn("Customer orders fetch error:", err);
            }
        }

        function subscribeToCustomerOrderUpdates() {
            if (!currentCustomer) return;
            if (orderRealtimeChannel) {
                supabaseClient.removeChannel(orderRealtimeChannel);
            }

            orderRealtimeChannel = supabaseClient
                .channel(`customer-orders-${currentCustomer.id}`)
                .on(
                    'postgres_changes',
                    {
                        event: 'UPDATE',
                        schema: 'public',
                        table: 'customer_orders',
                        filter: `customer_id=eq.${currentCustomer.id}`
                    },
                    async () => {
                        await fetchMyCustomerOrders(false);
                        await fetchLiveSupabaseData();
                    }
                )
                .subscribe();
        }

        // Poll every 5 seconds as a rock-solid backup so the customer gets notified while browsing
        setInterval(() => {
            if (currentCustomer) {
                fetchMyCustomerOrders(false);
            }
        }, 5000);

        function updateOrdersBadge() {
            const count = myCustomerOrders.length;
            document.getElementById('orderCountBadge').textContent = count;
            const sidebarBadge = document.getElementById('sidebarOrderBadge');
            if (sidebarBadge) sidebarBadge.textContent = count;
        }

        function openOrdersModal() {
            if (!currentCustomer) {
                showToast("Sign In Required", "Please sign in or register to view your personal order history.");
                openCustomerAccountModal();
                return;
            }
            fetchMyCustomerOrders(false);
            renderMyOrdersTable();
            document.getElementById('ordersModal').classList.remove('hidden');
        }

        function closeOrdersModal() {
            document.getElementById('ordersModal').classList.add('hidden');
        }

        function renderMyOrdersTable() {
            const tbody = document.getElementById('ordersTableBody');
            const subtitle = document.getElementById('ordersModalSubtitle');
            if (currentCustomer) {
                subtitle.textContent = `Showing orders exclusively for ${currentCustomer.full_name} (${currentCustomer.email})`;
            }

            if (myCustomerOrders.length === 0) {
                tbody.innerHTML = `
                    <tr>
                        <td colspan="6" class="py-10 text-center text-slate-400">
                            You haven't placed any online orders under this account yet.
                        </td>
                    </tr>
                `;
                return;
            }

            tbody.innerHTML = myCustomerOrders.map(order => {
                const pharm = pharmaciesTable.find(p => p.id === order.pharmacy_id);
                const pharmName = pharm ? `${pharm.pharmacy_name} (${pharm.city || ''})` : 'Registered Pharmacy';
                const items = order.customer_order_items || [];
                const itemsHtml = items.map(i => `<div>• <strong>${i.quantity}x</strong> ${i.medicine_name || 'Medicine'} (Rs. ${parseFloat(i.unit_price).toFixed(2)})</div>`).join('');

                const approval = order.cashier_approval_status || 'Pending';
                let statusBadge = '';
                if (approval === 'Accepted') {
                    statusBadge = `<span class="px-2.5 py-1 rounded-full text-[11px] font-extrabold bg-emerald-100 text-emerald-800 border border-emerald-300"><i class="fa-solid fa-circle-check mr-1"></i>Accepted (${order.payment_status})</span>`;
                } else if (approval === 'Rejected') {
                    statusBadge = `<span class="px-2.5 py-1 rounded-full text-[11px] font-extrabold bg-rose-100 text-rose-800 border border-rose-300"><i class="fa-solid fa-circle-xmark mr-1"></i>Rejected</span>
                                   ${order.rejection_reason ? `<div class="text-[10px] text-rose-600 mt-1">Reason: ${order.rejection_reason}</div>` : ''}`;
                } else {
                    statusBadge = `<span class="px-2.5 py-1 rounded-full text-[11px] font-extrabold bg-amber-100 text-amber-800 border border-amber-300 animate-pulse"><i class="fa-solid fa-clock mr-1"></i>Pending Cashier Review</span>`;
                }

                const slipLink = order.receipt_image_url
                    ? `<a href="${order.receipt_image_url}" target="_blank" class="text-brand-600 font-bold hover:underline block mt-0.5"><i class="fa-solid fa-image mr-1"></i>View Uploaded Slip</a>`
                    : '';

                return `
                    <tr class="hover:bg-slate-50 transition">
                        <td class="py-3.5 px-4">
                            <span class="font-extrabold text-teal-800 bg-teal-50 px-2 py-0.5 rounded border border-teal-200">${order.invoice_no || order.id.slice(0, 8)}</span>
                            <div class="text-[11px] text-slate-400 mt-1">${new Date(order.created_at).toLocaleString()}</div>
                        </td>
                        <td class="py-3.5 px-4 font-bold text-slate-800">
                            ${pharmName}
                            <div class="text-[10px] text-slate-400 font-normal">Deliver to: ${order.delivery_address || '-'}</div>
                        </td>
                        <td class="py-3.5 px-4 space-y-0.5">${itemsHtml || '1x Medicine'}</td>
                        <td class="py-3.5 px-4">
                            <span class="font-semibold">${order.payment_method}</span>
                            <div class="text-[11px] text-slate-500">${order.bank_reference || ''}</div>
                            ${slipLink}
                        </td>
                        <td class="py-3.5 px-4 font-extrabold text-slate-900">Rs. ${parseFloat(order.total_amount || 0).toFixed(2)}</td>
                        <td class="py-3.5 px-4">${statusBadge}</td>
                    </tr>
                `;
            }).join('');
        }

        // ---------------------------------------------------------
        // 8. HAVERSINE DISTANCE & GOOGLE MAPS URL BUILDER
        // ---------------------------------------------------------
        function calculateDistanceKm(lat1, lon1, lat2, lon2) {
            const parsedLat2 = parseFloat(lat2);
            const parsedLon2 = parseFloat(lon2);
            if (isNaN(parsedLat2) || isNaN(parsedLon2)) return 999.99;

            const R = 6371;
            const dLat = (parsedLat2 - lat1) * Math.PI / 180;
            const dLon = (parsedLon2 - lon1) * Math.PI / 180;
            const a =
                Math.sin(dLat / 2) * Math.sin(dLat / 2) +
                Math.cos(lat1 * Math.PI / 180) * Math.cos(parsedLat2 * Math.PI / 180) *
                Math.sin(dLon / 2) * Math.sin(dLon / 2);
            const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
            return R * c;
        }

        function buildGoogleMapsDirectionsUrl(pharmacy) {
            const origin = `${userLocation.lat},${userLocation.lng}`;
            const lat = parseFloat(pharmacy.latitude);
            const lng = parseFloat(pharmacy.longitude);
            let destination = '';
            if (!isNaN(lat) && !isNaN(lng)) {
                destination = `${lat},${lng}`;
            } else {
                destination = encodeURIComponent(`${pharmacy.pharmacy_name || ''} ${pharmacy.address || ''} ${pharmacy.city || ''} Sri Lanka`.trim());
            }
            return `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(origin)}&destination=${destination}&travelmode=driving`;
        }

        function matchesCategoryFilter(stockCategory, filterCategory) {
            if (filterCategory === 'ALL') return true;
            if (!stockCategory) return false;
            const normStock = stockCategory.toLowerCase();
            const normFilter = filterCategory.toLowerCase();
            if (normStock === normFilter) return true;
            if (normFilter.includes('inhaler') && (normStock.includes('inhaler') || normStock.includes('drop'))) return true;
            if (normFilter.includes('tablet') && (normStock.includes('tablet') || normStock.includes('pill'))) return true;
            if (normFilter.includes('capsule') && normStock.includes('capsule')) return true;
            if (normFilter.includes('syrup') && (normStock.includes('syrup') || normStock.includes('suspension'))) return true;
            if (normFilter.includes('injection') && (normStock.includes('injection') || normStock.includes('vial'))) return true;
            if (normFilter.includes('cream') && (normStock.includes('cream') || normStock.includes('ointment') || normStock.includes('gel'))) return true;
            return false;
        }

        function fetchUserLocation() {
            const btnTitle = document.getElementById('locationBtnTitle');
            const coordsBadge = document.getElementById('locationCoordsBadge');
            btnTitle.textContent = "Locating GPS...";

            if (!navigator.geolocation) {
                showToast("Geolocation Unsupported", "Using default Moratuwa coordinates.");
                btnTitle.textContent = "Location Active";
                return;
            }

            navigator.geolocation.getCurrentPosition(
                (position) => {
                    userLocation.lat = position.coords.latitude;
                    userLocation.lng = position.coords.longitude;
                    userLocation.isLiveGps = true;
                    userLocation.label = `GPS (${userLocation.lat.toFixed(4)}, ${userLocation.lng.toFixed(4)})`;

                    btnTitle.textContent = "Live GPS Locked";
                    coordsBadge.textContent = userLocation.label;

                    applyFiltersAndRender();
                    renderPharmaciesDirectory();
                    showToast("Current Location Fetched!", `Distances & Google Maps routes updated from ${userLocation.label}.`);
                },
                () => {
                    userLocation.lat = 6.79652;
                    userLocation.lng = 79.90053;
                    userLocation.label = "Moratuwa (6.7965, 79.9005)";
                    btnTitle.textContent = "Moratuwa GPS Set";
                    coordsBadge.textContent = userLocation.label;

                    applyFiltersAndRender();
                    renderPharmaciesDirectory();
                    showToast("Location Calibrated", "Using Moratuwa coordinates (6.7965, 79.9005) to rank pharmacies.");
                },
                { enableHighAccuracy: true, timeout: 6000 }
            );
        }

        // ---------------------------------------------------------
        // 9. SIDEBAR, AGGREGATION & TILE RENDERING
        // ---------------------------------------------------------
        function toggleSidebar() {
            const sidebar = document.getElementById('geminiSidebar');
            const backdrop = document.getElementById('mobileSidebarBackdrop');
            sidebarOpen = !sidebarOpen;
            if (sidebarOpen) {
                sidebar.classList.remove('sidebar-collapsed');
                sidebar.classList.add('sidebar-expanded');
                if (backdrop) backdrop.classList.remove('hidden');
            } else {
                sidebar.classList.remove('sidebar-expanded');
                sidebar.classList.add('sidebar-collapsed');
                if (backdrop) backdrop.classList.add('hidden');
            }
        }

        function focusSearchBar() {
            switchView('home');
            const input = document.getElementById('searchInput');
            if (input) {
                input.focus();
                input.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
        }

        function renderCategorySidebar() {
            const container = document.getElementById('categoryListContainer');
            const allAggregated = getAggregatedMedicines();

            container.innerHTML = MEDICINE_CATEGORIES.map(cat => {
                const count = allAggregated.filter(m =>
                    cat.id === 'ALL' ? true : m.allCategories.some(c => matchesCategoryFilter(c, cat.id))
                ).length;
                const isActive = selectedCategory === cat.id;

                return `
                    <button onclick="selectCategory('${cat.id}')"
                        class="w-full flex items-center justify-between px-4 py-2.5 rounded-full text-left text-sm transition ${
                            isActive
                                ? 'bg-gemdark-700 text-white font-semibold shadow-inner'
                                : 'text-slate-300 hover:bg-gemdark-800 hover:text-white font-medium'
                        }">
                        <div class="flex items-center space-x-3.5 truncate">
                            <i class="fa-solid ${cat.icon} w-4 text-center ${isActive ? 'text-brand-400' : 'text-slate-400'}"></i>
                            <span class="truncate">${cat.label}</span>
                        </div>
                        <span class="text-xs font-semibold px-2 py-0.5 rounded-full ${
                            isActive ? 'bg-brand-500/20 text-brand-300' : 'text-slate-500'
                        }">${count}</span>
                    </button>
                `;
            }).join('');
        }

        function selectCategory(catId) {
            selectedCategory = catId;
            document.getElementById('activeCategoryPill').textContent = catId === 'ALL' ? 'All Categories' : catId;
            renderCategorySidebar();
            applyFiltersAndRender();
        }

        function getAggregatedMedicines() {
            const groupedByName = new Map();

            grnStockTable.forEach(stock => {
                const rawName = (stock.medicine_name || '').trim();
                if (!rawName) return;
                const key = rawName.toLowerCase();

                const pharm = pharmaciesTable.find(p => p.id === stock.pharmacy_id) || {
                    id: stock.pharmacy_id,
                    pharmacy_name: "Registered Pharmacy",
                    license_no: "Verified",
                    phone: "+94 76 626 0341",
                    operating_hours: "8:00 AM - 10:00 PM",
                    city: "Moratuwa",
                    address: "Main Street",
                    latitude: "6.79652",
                    longitude: "79.90053",
                    image_url: ""
                };

                const distKm = calculateDistanceKm(userLocation.lat, userLocation.lng, pharm.latitude, pharm.longitude);

                const enrichedStock = {
                    ...stock,
                    selling_price_num: parseFloat(stock.selling_price || 0),
                    current_quantity_num: parseInt(stock.current_quantity || 0, 10),
                    pharmacy: pharm,
                    distanceKm: distKm
                };

                if (!groupedByName.has(key)) {
                    groupedByName.set(key, {
                        id: stock.medicine_id || stock.id,
                        key: key,
                        name: rawName,
                        pharmacyStocks: [enrichedStock]
                    });
                } else {
                    groupedByName.get(key).pharmacyStocks.push(enrichedStock);
                }
            });

            const list = Array.from(groupedByName.values()).map(group => {
                group.pharmacyStocks.sort((a, b) => a.distanceKm - b.distanceKm);
                const primary = group.pharmacyStocks[0];
                const totalStock = group.pharmacyStocks.reduce((sum, s) => sum + s.current_quantity_num, 0);
                const totalReceived = group.pharmacyStocks.reduce((sum, s) => sum + parseInt(s.quantity_received || 0, 10), 0);

                const txSold = salesTransactionsTable
            .filter(tx => (tx.medicine_name || '').toLowerCase() === group.key)
            .reduce((sum, tx) => sum + parseInt(tx.quantity_sold || 0, 10), 0);

                // Rank #1 is now strictly the medicine with the highest total quantity sold
                // The tiny decimal (totalStock / 10000) acts only as a tie-breaker for items with 0 sales
                const popularityScore = txSold + (totalStock / 10000);

                const allCategories = [...new Set(group.pharmacyStocks.map(s => s.category).filter(Boolean))];
                const displayCategory = primary.category === "Inhaler" ? "Inhaler / Drops" : (primary.category || "Tablet / Pill");
                const validPrices = group.pharmacyStocks.map(s => s.selling_price_num).filter(p => p > 0);
                const minPrice = validPrices.length > 0 ? Math.min(...validPrices) : 0;

                // Collect all uploaded photos for this medicine across the medicines catalog
                const medicineImages = [...new Set(
                    medicinesTable
                        .filter(m => (m.name || '').trim().toLowerCase() === group.key && Array.isArray(m.image_urls))
                        .flatMap(m => m.image_urls)
                        .filter(Boolean)
                )];

                return {
                    ...group,
                    category: displayCategory,
                    allCategories,
                    supplier_name: primary.supplier_name || 'Verified Supplier',
                    minPrice,
                    totalStock,
                    nearestDistanceKm: primary.distanceKm,
                    nearestPharmacyName: primary.pharmacy.pharmacy_name,
                    expiry_date: primary.expiry_date || 'N/A',
                    batch_number: primary.batch_number || 'N/A',
                    popularityScore,
                    images: medicineImages
                };
            });

            list.sort((a, b) => b.popularityScore - a.popularityScore);
            list.forEach((item, idx) => { item.popularityRank = idx + 1; });
            return list;
        }

        function getCategoryIcon(category) {
            const c = (category || '').toLowerCase();
            if (c.includes('inhaler') || c.includes('drop')) return 'fa-lungs';
            if (c.includes('tablet') || c.includes('pill')) return 'fa-tablets';
            if (c.includes('capsule')) return 'fa-capsules';
            if (c.includes('syrup') || c.includes('suspension')) return 'fa-prescription-bottle';
            if (c.includes('injection') || c.includes('vial')) return 'fa-syringe';
            if (c.includes('cream') || c.includes('ointment')) return 'fa-pump-medical';
            return 'fa-pills';
        }

        function applyFiltersAndRender() {
            const searchVal = (document.getElementById('searchInput').value || '').trim().toLowerCase();
            const sortVal = document.getElementById('sortFilter').value;
            const cityVal = document.getElementById('cityFilter').value;
            const supplierVal = document.getElementById('supplierFilter').value;
            const maxPriceVal = parseFloat(document.getElementById('priceFilter').value || 25000);
            const inStockOnly = document.getElementById('inStockOnlyFilter').checked;

            const clearBtn = document.getElementById('clearSearchBtn');
            if (searchVal.length > 0) clearBtn.classList.remove('hidden');
            else clearBtn.classList.add('hidden');

            const rawAggregated = getAggregatedMedicines();

            let filteredMedicines = rawAggregated.map(med => {
                const matchingStocks = med.pharmacyStocks.filter(s => {
                    const catMatch = matchesCategoryFilter(s.category, selectedCategory);
                    const cityMatch = cityVal === 'ALL' || ((s.pharmacy.city || '').trim().toLowerCase() === cityVal.trim().toLowerCase());
                    const supMatch = supplierVal === 'ALL' || ((s.supplier_name || '').trim().toLowerCase() === supplierVal.trim().toLowerCase());
                    const priceMatch = s.selling_price_num <= maxPriceVal;
                    const stockMatch = !inStockOnly || s.current_quantity_num > 0;
                    return catMatch && cityMatch && supMatch && priceMatch && stockMatch;
                });

                if (matchingStocks.length === 0) return null;

                if (searchVal) {
                    const nameMatch = med.name.toLowerCase().includes(searchVal);
                    const stockSearchMatch = matchingStocks.some(s =>
                        (s.supplier_name || '').toLowerCase().includes(searchVal) ||
                        (s.category || '').toLowerCase().includes(searchVal) ||
                        (s.pharmacy.pharmacy_name || '').toLowerCase().includes(searchVal) ||
                        (s.pharmacy.city || '').toLowerCase().includes(searchVal)
                    );
                    if (!nameMatch && !stockSearchMatch) return null;
                }

                matchingStocks.sort((a, b) => a.distanceKm - b.distanceKm);
                const closest = matchingStocks[0];
                const filteredTotalStock = matchingStocks.reduce((sum, s) => sum + s.current_quantity_num, 0);
                const validPrices = matchingStocks.map(s => s.selling_price_num).filter(p => p > 0);
                const filteredMinPrice = validPrices.length > 0 ? Math.min(...validPrices) : 0;

                return {
                    ...med,
                    category: closest.category === "Inhaler" ? "Inhaler / Drops" : (closest.category || med.category),
                    supplier_name: closest.supplier_name || med.supplier_name,
                    minPrice: filteredMinPrice,
                    totalStock: filteredTotalStock,
                    nearestDistanceKm: closest.distanceKm,
                    nearestPharmacyName: closest.pharmacy.pharmacy_name,
                    expiry_date: closest.expiry_date || med.expiry_date,
                    batch_number: closest.batch_number || med.batch_number,
                    filteredPharmacyStocks: matchingStocks
                };
            }).filter(Boolean);

            filteredMedicines.sort((a, b) => {
                if (sortVal === 'popular_asc') return a.popularityRank - b.popularityRank;
                if (sortVal === 'price_asc') return a.minPrice - b.minPrice;
                if (sortVal === 'price_desc') return b.minPrice - a.minPrice;
                if (sortVal === 'nearest') return a.nearestDistanceKm - b.nearestDistanceKm;
                if (sortVal === 'name_asc') return a.name.localeCompare(b.name);
                return a.popularityRank - b.popularityRank;
            });

            document.getElementById('resultsCountText').textContent = filteredMedicines.length;

            const grid = document.getElementById('medicineTilesGrid');
            const emptyState = document.getElementById('emptyResultsState');

            if (filteredMedicines.length === 0) {
                grid.innerHTML = '';
                emptyState.classList.remove('hidden');
                return;
            }

            emptyState.classList.add('hidden');

            grid.innerHTML = filteredMedicines.map((item, displayIdx) => {
                const nearest5Count = Math.min(5, item.filteredPharmacyStocks.length);
                const iconClass = getCategoryIcon(item.category);
                const rankNumber = sortVal === 'popular_asc' ? item.popularityRank : (displayIdx + 1);
                const isTopThreePopular = item.popularityRank <= 3;
                const closestStockId = item.filteredPharmacyStocks[0].id;
                const photos = Array.isArray(item.images) ? item.images : [];

                const rankBadgeHtml = isTopThreePopular
                    ? `<span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-extrabold bg-amber-100 text-amber-800 border border-amber-300">
                           <i class="fa-solid fa-fire text-amber-500"></i>
                           #${item.popularityRank} Most Popular
                       </span>`
                    : `<span class="inline-flex items-center px-2.5 py-1 rounded-lg text-[11px] font-bold bg-slate-100 text-slate-600 border border-slate-200">
                           #${rankNumber}
                       </span>`;

                // Build single photo or auto-looping multi-photo banner
                const photoBannerHtml = photos.length > 0 ? `
                    <div class="relative w-full h-44 bg-slate-100 border-b border-slate-100 overflow-hidden group"
                         data-med-carousel="${photos.length > 1 ? 'true' : 'false'}"
                         data-active-index="0"
                         data-total-slides="${photos.length}">
                        ${photos.map((imgUrl, imgIdx) => `
                            <img src="${imgUrl}" alt="${item.name}"
                                 data-carousel-slide="${imgIdx}"
                                 class="w-full h-full object-contain p-2 bg-white transition-opacity duration-700 absolute inset-0 ${imgIdx === 0 ? 'opacity-100 z-10' : 'opacity-0 z-0'}">
                        `).join('')}
                        ${photos.length > 1 ? `
                            <div class="absolute bottom-2 left-1/2 -translate-x-1/2 z-20 flex items-center gap-1.5 bg-slate-900/60 backdrop-blur-sm px-2.5 py-1 rounded-full">
                                ${photos.map((_, dotIdx) => `
                                    <span data-carousel-dot="${dotIdx}" class="w-1.5 h-1.5 rounded-full transition-all ${dotIdx === 0 ? 'bg-brand-400 w-3.5' : 'bg-white/60'}"></span>
                                `).join('')}
                            </div>
                        ` : ''}
                    </div>
                ` : '';

                return `
                    <div class="bg-white rounded-2xl border border-slate-200/90 shadow-sm card-hover flex flex-col justify-between overflow-hidden">
                        <div>
                            <div class="p-4 pb-3 bg-gradient-to-br from-slate-50 to-teal-50/40 border-b border-slate-100 flex items-center justify-between gap-2">
                                ${rankBadgeHtml}
                                <span class="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-bold bg-teal-50 text-teal-700 border border-teal-200">
                                    <i class="fa-solid ${iconClass}"></i>
                                    ${item.category}
                                </span>
                            </div>

                            ${photoBannerHtml}

                            <div class="p-4">
                                <div class="flex items-start justify-between gap-3 mb-3">
                                    <h3 class="text-base font-extrabold text-slate-900 leading-snug">${item.name}</h3>
                                    <div class="w-10 h-10 rounded-xl bg-brand-50 text-brand-600 border border-brand-100 flex items-center justify-center flex-shrink-0 text-lg">
                                        <i class="fa-solid ${iconClass}"></i>
                                    </div>
                                </div>

                                <div class="bg-slate-50 rounded-xl p-2.5 border border-slate-100 space-y-1.5 text-[11px] text-slate-600">
                                    <div class="flex items-center justify-between">
                                        <span class="text-slate-400">Supplier:</span>
                                        <span class="font-semibold text-slate-800 truncate max-w-[180px]">${item.supplier_name}</span>
                                    </div>
                                    <div class="flex items-center justify-between">
                                        <span class="text-slate-400">Closest Pharmacy:</span>
                                        <span class="font-bold text-teal-700">
                                            <i class="fa-solid fa-location-dot mr-0.5"></i> ${item.nearestPharmacyName} (${item.nearestDistanceKm.toFixed(2)} km)
                                        </span>
                                    </div>
                                    <div class="flex items-center justify-between">
                                        <span class="text-slate-400">Batch & Expiry:</span>
                                        <span class="font-mono text-slate-700">${item.batch_number} • Exp: ${item.expiry_date}</span>
                                    </div>
                                </div>
                            </div>
                        </div>

                        <div class="px-4 pb-4 pt-2 border-t border-slate-100">
                            <div class="flex items-end justify-between mb-3">
                                <div>
                                    <span class="text-[10px] font-bold uppercase tracking-wider text-slate-400 block">Selling Price From</span>
                                    <span class="text-xl font-extrabold text-slate-900">Rs. ${item.minPrice.toFixed(2)}</span>
                                </div>
                                <div class="text-right">
                                    <span class="inline-flex items-center gap-1 text-[11px] font-bold text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded-md border border-emerald-200">
                                        <span class="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>
                                        ${item.totalStock} Units in Stock
                                    </span>
                                    <span class="block text-[10px] text-slate-400 mt-0.5">In ${nearest5Count} Nearest Pharmacy${nearest5Count === 1 ? '' : 's'}</span>
                                </div>
                            </div>

                            <div class="flex gap-2">
                                <button onclick="addToCart('${closestStockId}', 1, false)" title="Quick Add Closest Pharmacy Stock to Cart"
                                    class="px-3.5 py-2.5 rounded-xl bg-emerald-50 hover:bg-emerald-100 text-emerald-800 border border-emerald-300 font-bold text-xs transition flex items-center justify-center gap-1.5">
                                    <i class="fa-solid fa-cart-plus"></i>
                                    <span>Add</span>
                                </button>
                                <button onclick="openNearestPharmaciesModal('${encodeURIComponent(item.key)}')"
                                    class="flex-1 bg-gradient-to-r from-brand-600 to-teal-700 hover:from-brand-500 hover:to-teal-600 text-white font-bold text-xs py-2.5 px-3 rounded-xl shadow-md transition flex items-center justify-center gap-1.5">
                                    <i class="fa-solid fa-map-location-dot"></i>
                                    <span>Nearest 5 Pharmacies & Buy</span>
                                </button>
                            </div>
                        </div>
                    </div>
                `;
            }).join('');
        }

        function openNearestPharmaciesModal(encodedMedKey) {
            const medKey = decodeURIComponent(encodedMedKey);
            const med = getAggregatedMedicines().find(m => m.key === medKey);
            if (!med) return;

            document.getElementById('modalMedCategoryBadge').textContent = med.category;
            document.getElementById('modalMedName').textContent = med.name;
            document.getElementById('modalUserLocationNote').innerHTML = `
                <i class="fa-solid fa-location-crosshairs mr-1"></i> Ranked by distance from <strong>${userLocation.label}</strong> • Showing Nearest 5 Pharmacies with stock
            `;

            const nearest5 = med.pharmacyStocks
                .filter(s => s.current_quantity_num > 0)
                .sort((a, b) => a.distanceKm - b.distanceKm)
                .slice(0, 5);

            const listContainer = document.getElementById('nearestPharmaciesList');

            if (nearest5.length === 0) {
                listContainer.innerHTML = `<p class="text-sm text-slate-500 text-center py-8">Currently out of stock across registered pharmacies.</p>`;
            } else {
                listContainer.innerHTML = nearest5.map((entry, idx) => {
                    const p = entry.pharmacy;
                    const isClosest = idx === 0;
                    const mapsUrl = buildGoogleMapsDirectionsUrl(p);

                    return `
                        <div class="bg-white rounded-2xl p-4 sm:p-5 border-2 ${
                            isClosest ? 'border-brand-500 shadow-md' : 'border-slate-200'
                        } flex flex-col lg:flex-row lg:items-center justify-between gap-4">
                            
                            <div class="flex items-start gap-4">
                                <div class="relative flex-shrink-0">
                                    <img src="${p.image_url || ''}"
                                         onerror="this.src='https://placehold.co/120x120/0d9488/ffffff?text=${encodeURIComponent(p.pharmacy_name || 'Pharmacy')}'"
                                         alt="${p.pharmacy_name}"
                                         class="w-16 h-16 sm:w-20 sm:h-20 rounded-2xl object-cover border border-slate-200">
                                    <span class="absolute -top-2 -left-2 w-7 h-7 rounded-xl ${
                                        isClosest ? 'bg-brand-600 text-white' : 'bg-slate-800 text-white'
                                    } font-extrabold text-xs flex items-center justify-center shadow">
                                        #${idx + 1}
                                    </span>
                                </div>

                                <div class="space-y-1">
                                    <div class="flex flex-wrap items-center gap-2">
                                        <h4 class="text-base sm:text-lg font-extrabold text-slate-900">${p.pharmacy_name}</h4>
                                        ${isClosest ? `<span class="text-[10px] font-extrabold uppercase px-2 py-0.5 rounded-full bg-brand-100 text-brand-800 border border-brand-300">Closest to You</span>` : ''}
                                        <span class="text-xs font-bold text-amber-700 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded-lg">
                                            <i class="fa-solid fa-route mr-1"></i>${entry.distanceKm.toFixed(2)} km away
                                        </span>
                                    </div>

                                    <p class="text-xs text-slate-600">
                                        <i class="fa-solid fa-location-dot text-teal-600 mr-1"></i>
                                        <strong>${p.address || ''}${p.address && p.city ? ', ' : ''}${p.city || ''}</strong>
                                    </p>

                                    <div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-slate-500 pt-1">
                                        <span><i class="fa-regular fa-clock text-teal-600 mr-1"></i>${p.operating_hours || '8:00 AM - 10:00 PM'}</span>
                                        <span><i class="fa-solid fa-phone text-teal-600 mr-1"></i>${p.phone || 'N/A'}</span>
                                        <span><i class="fa-solid fa-id-card text-teal-600 mr-1"></i>License: <strong>${p.license_no || 'Verified'}</strong></span>
                                    </div>

                                    <div class="flex flex-wrap items-center gap-2 pt-1.5">
                                        <span class="text-[11px] bg-slate-100 text-slate-700 px-2 py-0.5 rounded font-medium">
                                            Rack: <strong>${entry.rack_location || 'Main Shelf'}</strong>
                                        </span>
                                        <span class="text-[11px] bg-emerald-50 text-emerald-700 border border-emerald-200 px-2 py-0.5 rounded font-bold">
                                            ${entry.current_quantity_num} units in stock
                                        </span>
                                    </div>
                                </div>
                            </div>

                            <div class="flex flex-col sm:flex-row lg:flex-col items-stretch sm:items-center lg:items-end justify-between border-t lg:border-t-0 pt-3 lg:pt-0 border-slate-100 flex-shrink-0 gap-2.5">
                                <div class="text-left lg:text-right">
                                    <span class="text-[10px] uppercase font-bold text-slate-400 block">Pharmacy Unit Price</span>
                                    <span class="text-xl font-extrabold text-slate-900">Rs. ${entry.selling_price_num.toFixed(2)}</span>
                                </div>

                                <div class="flex flex-wrap items-center gap-2">
                                    <a href="${mapsUrl}" target="_blank" rel="noopener noreferrer"
                                        class="bg-emerald-50 hover:bg-emerald-100 text-emerald-800 border border-emerald-300 font-bold text-xs px-3 py-2.5 rounded-xl shadow-sm transition flex items-center justify-center gap-1.5">
                                        <i class="fa-solid fa-diamond-turn-right text-emerald-600"></i>
                                        <span>Google Maps</span>
                                    </a>

                                    <button onclick="addToCart('${entry.id}', 1, false)"
                                        class="bg-teal-50 hover:bg-teal-100 text-teal-800 border border-teal-300 font-bold text-xs px-3.5 py-2.5 rounded-xl transition flex items-center justify-center gap-1.5">
                                        <i class="fa-solid fa-cart-plus"></i>
                                        <span>Add to Cart</span>
                                    </button>

                                    <button onclick="buySingleStockItemNow('${entry.id}')"
                                        class="bg-slate-900 hover:bg-brand-600 text-white font-bold text-xs px-4 py-2.5 rounded-xl shadow transition flex items-center justify-center gap-1.5">
                                        <i class="fa-solid fa-bag-shopping"></i>
                                        <span>Buy from ${p.pharmacy_name}</span>
                                    </button>
                                </div>
                            </div>

                        </div>
                    `;
                }).join('');
            }

            document.getElementById('nearestPharmaciesModal').classList.remove('hidden');
        }

        function closeNearestModal() {
            document.getElementById('nearestPharmaciesModal').classList.add('hidden');
        }

        function renderPharmaciesDirectory() {
            const container = document.getElementById('pharmaciesDirectoryGrid');
            const ranked = pharmaciesTable.map(p => ({
                ...p,
                distanceKm: calculateDistanceKm(userLocation.lat, userLocation.lng, p.latitude, p.longitude)
            })).sort((a, b) => a.distanceKm - b.distanceKm);

            if (ranked.length === 0) {
                container.innerHTML = `<p class="text-xs text-slate-500 col-span-full">Loading registered pharmacies from Supabase...</p>`;
                return;
            }

            container.innerHTML = ranked.map((p, idx) => {
                const mapsUrl = buildGoogleMapsDirectionsUrl(p);
                return `
                    <div class="p-4 rounded-2xl bg-slate-50 hover:bg-teal-50/40 border border-slate-200 transition flex flex-col justify-between gap-3">
                        <div class="flex items-center gap-3.5">
                            <img src="${p.image_url || ''}"
                                 onerror="this.src='https://placehold.co/100x100/0d9488/ffffff?text=${encodeURIComponent(p.pharmacy_name || 'P')}'"
                                 alt="${p.pharmacy_name}" class="w-14 h-14 rounded-2xl object-cover border border-slate-300 flex-shrink-0">
                            <div class="min-w-0 flex-1">
                                <div class="flex items-center justify-between gap-1">
                                    <h4 class="text-sm font-extrabold text-slate-900 truncate">#${idx + 1} ${p.pharmacy_name}</h4>
                                    <span class="text-[11px] font-bold text-teal-700 bg-teal-100 px-2 py-0.5 rounded-md flex-shrink-0">
                                        ${p.distanceKm.toFixed(2)} km
                                    </span>
                                </div>
                                <p class="text-xs text-slate-600 truncate">${p.address || ''}${p.address && p.city ? ', ' : ''}${p.city || ''}</p>
                                <div class="flex items-center justify-between text-[11px] text-slate-500 mt-1">
                                    <span><i class="fa-solid fa-phone text-teal-600 mr-1"></i>${p.phone || 'N/A'}</span>
                                    <span>Lic: ${p.license_no || 'N/A'}</span>
                                </div>
                            </div>
                        </div>
                        <a href="${mapsUrl}" target="_blank" rel="noopener noreferrer"
                           class="w-full py-2 px-3 rounded-xl bg-white hover:bg-emerald-50 text-emerald-700 border border-emerald-200 text-xs font-bold flex items-center justify-center gap-1.5 transition">
                            <i class="fa-solid fa-map-location-dot"></i>
                            <span>Find on Google Maps</span>
                        </a>
                    </div>
                `;
            }).join('');
        }

        function updatePriceLabel() {
            const val = document.getElementById('priceFilter').value;
            document.getElementById('priceRangeLabel').textContent = `Rs. ${Number(val).toLocaleString()}`;
        }

        function clearSearch() {
            document.getElementById('searchInput').value = '';
            applyFiltersAndRender();
        }

        function resetAllFilters() {
            document.getElementById('searchInput').value = '';
            document.getElementById('sortFilter').value = 'popular_asc';
            document.getElementById('cityFilter').value = 'ALL';
            document.getElementById('supplierFilter').value = 'ALL';
            const priceSlider = document.getElementById('priceFilter');
            priceSlider.value = priceSlider.max || 25000;
            document.getElementById('inStockOnlyFilter').checked = true;
            updatePriceLabel();
            selectCategory('ALL');
        }

        function switchView(view) {
            const homeView = document.getElementById('homeView');
            const aboutView = document.getElementById('aboutView');
            const navHomeBtn = document.getElementById('navHomeBtn');
            const navAboutBtn = document.getElementById('navAboutBtn');

            if (view === 'about') {
                homeView.classList.add('hidden');
                aboutView.classList.remove('hidden');
                navAboutBtn.className = "px-4 py-2 rounded-xl text-xs sm:text-sm font-semibold transition flex items-center gap-2 bg-brand-600 text-white shadow-md shadow-brand-600/30";
                navHomeBtn.className = "px-4 py-2 rounded-xl text-xs sm:text-sm font-semibold text-slate-300 hover:text-white hover:bg-slate-700/60 transition flex items-center gap-2";
                window.scrollTo({ top: 0, behavior: 'smooth' });
            } else {
                aboutView.classList.add('hidden');
                homeView.classList.remove('hidden');
                navHomeBtn.className = "px-4 py-2 rounded-xl text-xs sm:text-sm font-semibold transition flex items-center gap-2 bg-brand-600 text-white shadow-md shadow-brand-600/30";
                navAboutBtn.className = "px-4 py-2 rounded-xl text-xs sm:text-sm font-semibold text-slate-300 hover:text-white hover:bg-slate-700/60 transition flex items-center gap-2";
            }
        }

        function scrollToSupport(event) {
            if (event) event.preventDefault();
            const footerEl = document.getElementById('footer-support');
            const box = document.getElementById('supportHighlightBox');
            footerEl.scrollIntoView({ behavior: 'smooth' });
            box.classList.add('ring-4', 'ring-amber-400');
            setTimeout(() => box.classList.remove('ring-4', 'ring-amber-400'), 2500);
        }

        let toastTimer = null;
        function showToast(title, message) {
            const toast = document.getElementById('toastNotification');
            document.getElementById('toastTitle').textContent = title;
            document.getElementById('toastMessage').textContent = message;
            toast.classList.remove('hidden');
            if (toastTimer) clearTimeout(toastTimer);
            toastTimer = setTimeout(() => {
                toast.classList.add('hidden');
            }, 6000);
        }

        // Automatically cycle multi-photo carousels on medicine tiles every 2.8 seconds
        setInterval(() => {
            document.querySelectorAll('[data-med-carousel="true"]').forEach(carousel => {
                const total = parseInt(carousel.getAttribute('data-total-slides') || '1', 10);
                if (total <= 1) return;

                const current = parseInt(carousel.getAttribute('data-active-index') || '0', 10);
                const next = (current + 1) % total;
                carousel.setAttribute('data-active-index', String(next));

                carousel.querySelectorAll('[data-carousel-slide]').forEach((img, idx) => {
                    img.className = `w-full h-full object-contain p-2 bg-white transition-opacity duration-700 absolute inset-0 ${
                        idx === next ? 'opacity-100 z-10' : 'opacity-0 z-0'
                    }`;
                });

                carousel.querySelectorAll('[data-carousel-dot]').forEach((dot, idx) => {
                    dot.className = `w-1.5 h-1.5 rounded-full transition-all ${
                        idx === next ? 'bg-brand-400 w-3.5' : 'bg-white/60'
                    }`;
                });
            });
        }, 2800);

        window.addEventListener('DOMContentLoaded', () => {
            // Start with sidebar collapsed on phones/tablets (<1024px) so the main screen is 100% visible
            if (window.innerWidth < 1024) {
                sidebarOpen = false;
                const sidebar = document.getElementById('geminiSidebar');
                sidebar.classList.remove('sidebar-expanded');
                sidebar.classList.add('sidebar-collapsed');
            }
            updateCustomerHeaderUI();
            updateCartBadges();
            renderCategorySidebar();
            fetchLiveSupabaseData();
            if (currentCustomer) {
                subscribeToCustomerOrderUpdates();
            }
        });

let currentHeroSearchMode = 'medicines'; // 'medicines' | 'pharmacies'

function setHeroSearchMode(mode) {
    currentHeroSearchMode = mode;

    const medBtn = document.getElementById('modeBtnMedicines');
    const pharmBtn = document.getElementById('modeBtnPharmacies');
    
    // Update the selector below if your existing search input uses a different ID
    const searchInput = document.getElementById('heroSearchInput') || document.querySelector('input[placeholder*="Search by medicine"]');
    const searchBtnText = document.getElementById('heroSearchBtnText');

    if (medBtn) medBtn.classList.toggle('active', mode === 'medicines');
    if (pharmBtn) pharmBtn.classList.toggle('active', mode === 'pharmacies');

    if (mode === 'pharmacies') {
        if (searchInput) {
            searchInput.placeholder = 'Search pharmacies by name, city (e.g. Moratuwa), phone, or license...';
            searchInput.focus();
        }
        if (searchBtnText) searchBtnText.textContent = 'Find Pharmacy';
    } else {
        if (searchInput) {
            searchInput.placeholder = 'Search by medicine name, category, pharmacy, or supplier...';
            searchInput.focus();
        }
        if (searchBtnText) searchBtnText.textContent = 'Search Stock';
    }

    // Re-run filter immediately when switching tabs
    handleUnifiedHeroSearch();
}

function handleUnifiedHeroSearch() {
    const searchInput = document.getElementById('heroSearchInput') || document.querySelector('input[placeholder*="Search"]');
    const query = (searchInput ? searchInput.value : '').trim().toLowerCase();

    if (currentHeroSearchMode === 'pharmacies') {
        filterPharmaciesDirectory(query);
    } else {
        // Reset all pharmacy cards so none stay hidden when switching back
        filterPharmaciesDirectory('');
        
        // Trigger your existing medicine filter function if you have one
        if (typeof filterMedicines === 'function') {
            filterMedicines();
        } else if (typeof renderMedicines === 'function') {
            renderMedicines();
        }
    }
}

function executeUnifiedHeroSearch() {
    handleUnifiedHeroSearch();

    if (currentHeroSearchMode === 'pharmacies') {
        // Smoothly scroll down to the Live Geolocation Directory section
        const directoryHeading = Array.from(document.querySelectorAll('h2, h3, div')).find(
            el => el.textContent && el.textContent.includes('Registered Pharmacies Ranked by Distance')
        );
        if (directoryHeading) {
            directoryHeading.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
    }
}

function filterPharmaciesDirectory(query) {
    // Finds all pharmacy cards inside the Live Geolocation Directory
    // Adjust '.pharmacy-card-item' if your directory cards use a specific container ID
    const mapLinks = document.querySelectorAll('a[href*="google.com/maps"], button');
    const pharmacyCards = new Set();

    document.querySelectorAll('.pharmacy-card-item').forEach(c => pharmacyCards.add(c));

    // Automatic fallback: locate cards containing "Find on Google Maps" if .pharmacy-card-item wasn't added yet
    if (pharmacyCards.size === 0) {
        mapLinks.forEach(el => {
            if (el.textContent && el.textContent.includes('Find on Google Maps')) {
                const card = el.closest('div.bg-white, div[class*="rounded"]');
                if (card) pharmacyCards.add(card);
            }
        });
    }

    pharmacyCards.forEach(card => {
        const text = card.innerText.toLowerCase();
        card.style.display = (!query || text.includes(query)) ? '' : 'none';
    });
}