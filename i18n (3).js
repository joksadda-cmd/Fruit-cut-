/* i18n.js — Fruit Cut mini-app languages.
 *
 * Scope: the MINI APP UI only (index.html). Bot messages, admin panel and
 * server logs stay English on purpose.
 *
 * HOW IT WORKS (so the whole index.html didn't have to be rewritten):
 *   • The app keeps writing plain English text into the DOM, exactly as before.
 *   • This file watches the DOM (MutationObserver) and swaps every English
 *     text node / placeholder / title / aria-label for its translated
 *     equivalent from the DICTIONARY below. English is the "source" language:
 *     the original text is remembered per node, so switching language (or back
 *     to English) always re-translates from the English source.
 *   • Dictionary KEYS are the exact English strings. A key may contain numbered
 *     placeholders {0} {1} … for dynamic parts, e.g.
 *         'Lv. {0}'  →  'Уровень {0}'
 *     Numbers, names, wallet addresses etc. are captured and copied through.
 *   • To translate a NEW piece of UI text: add one row to DICTIONARY
 *     (English + 7 translations, in the same column order as CODES below).
 *     Text that has no entry simply stays English.
 *
 *   window.i18n.lang()        current language code
 *   window.i18n.setLang(code) switch + persist (localStorage 'fc_lang')
 *   window.i18n.t(key, ...args)  translate a string from JS code (for native
 *                                popups that don't go through the DOM)
 *   window.i18n.LANGS         { en:{name,short,dir}, bn:{…}, ru:{…}, … }
 */
(function () {
    'use strict';

    var LANGS = {
        en: { name: 'English', short: 'EN', flag: '🇬🇧', dir: 'ltr' },
        bn: { name: 'বাংলা', short: 'BN', flag: '🇧🇩', dir: 'ltr' },
        ru: { name: 'Русский', short: 'RU', flag: '🇷🇺', dir: 'ltr' },
        hi: { name: 'हिन्दी', short: 'HI', flag: '🇮🇳', dir: 'ltr' },
        tr: { name: 'Türkçe', short: 'TR', flag: '🇹🇷', dir: 'ltr' },
        es: { name: 'Español', short: 'ES', flag: '🇪🇸', dir: 'ltr' },
        ar: { name: 'العربية', short: 'AR', flag: '🇸🇦', dir: 'rtl' },
        id: { name: 'Bahasa Indonesia', short: 'ID', flag: '🇮🇩', dir: 'ltr' },
    };
    // Order the language picker is shown in (matches the requested list).
    var LANG_ORDER = ['en', 'bn', 'ru', 'hi', 'tr', 'es', 'ar', 'id'];
    var STORAGE_KEY = 'fc_lang';
    var CODES = ['bn', 'ru', 'hi', 'tr', 'es', 'ar', 'id'];

    // ── DICTIONARY: [English, bn, ru, hi, tr, es, ar, id] ──────────────────
    var DICTIONARY = [
        ["Connecting..","সংযোগ হচ্ছে..","Подключение..","कनेक्ट हो रहा है..","Bağlanıyor..","Conectando..","جارٍ الاتصال..","Menghubungkan.."],
        ["Loading...","লোড হচ্ছে...","Загрузка...","लोड हो रहा है...","Yükleniyor...","Cargando...","جارٍ التحميل...","Memuat..."],
        ["Account Blocked","অ্যাকাউন্ট ব্লক করা হয়েছে","Аккаунт заблокирован","खाता ब्लॉक है","Hesap Engellendi","Cuenta Bloqueada","تم حظر الحساب","Akun Diblokir"],
        ["🔄 I've Switched — Try Again","🔄 আমি পাল্টেছি — আবার চেষ্টা করুন","🔄 Я переключился — Повторить","🔄 मैंने बदल लिया — फिर से कोशिश करें","🔄 Değiştirdim — Tekrar Dene","🔄 Ya cambié — Reintentar","🔄 لقد قمت بالتبديل — حاول مرة أخرى","🔄 Saya Sudah Ganti — Coba Lagi"],
        ["Join to Continue","চালিয়ে যেতে জয়েন করুন","Вступите, чтобы продолжить","जारी रखने के लिए जॉइन करें","Devam Etmek İçin Katıl","Únete para Continuar","انضم للمتابعة","Gabung untuk Melanjutkan"],
        ["Join our official channels to unlock Fruit Cut — takes 10 seconds!","Fruit Cut আনলক করতে আমাদের অফিসিয়াল চ্যানেলে জয়েন করুন — মাত্র ১০ সেকেন্ড লাগবে!","Вступите в наши официальные каналы, чтобы открыть Fruit Cut — это займёт 10 секунд!","Fruit Cut अनलॉक करने के लिए हमारे ऑफिशियल चैनल जॉइन करें — सिर्फ 10 सेकंड लगेंगे!","Fruit Cut'ın kilidini açmak için resmi kanallarımıza katıl — sadece 10 saniye sürer!","Únete a nuestros canales oficiales para desbloquear Fruit Cut — ¡solo toma 10 segundos!","انضم إلى قنواتنا الرسمية لفتح Fruit Cut — يستغرق الأمر 10 ثوانٍ فقط!","Gabung ke channel resmi kami untuk membuka Fruit Cut — hanya butuh 10 detik!"],
        ["✅ I've Joined — Verify","✅ আমি জয়েন করেছি — ভেরিফাই করুন","✅ Я вступил — Проверить","✅ मैंने जॉइन कर लिया — वेरिफाई करें","✅ Katıldım — Doğrula","✅ Ya me uní — Verificar","✅ لقد انضممت — تحقّق","✅ Saya Sudah Gabung — Verifikasi"],
        ["Player","প্লেয়ার","Игрок","प्लेयर","Oyuncu","Jugador","اللاعب","Pemain"],
        ["✨ SLICE MANIA ✨","✨ স্লাইস ম্যানিয়া ✨","✨ СЛЭШ-МАНИЯ ✨","✨ स्लाइस मेनिया ✨","✨ DİLİMLEME ÇILGINLIĞI ✨","✨ MANÍA DE CORTES ✨","✨ جنون التقطيع ✨","✨ MANIA POTONG ✨"],
        ["12H TREASURE BOX","১২ ঘণ্টার ট্রেজার বক্স","СУНДУК КАЖДЫЕ 12Ч","12 घंटे का ट्रेजर बॉक्स","12S HAZİNE SANDIĞI","COFRE DE 12H","صندوق كنز كل 12 ساعة","KOTAK HARTA 12 JAM"],
        ["OPEN BOX (20–30 FC)","বক্স খুলুন (২০–৩০ FC)","ОТКРЫТЬ (20–30 FC)","बॉक्स खोलें (20–30 FC)","KUTUYU AÇ (20–30 FC)","ABRIR COFRE (20–30 FC)","افتح الصندوق (20–30 FC)","BUKA KOTAK (20–30 FC)"],
        ["⚔️ PLAY & SLICE","⚔️ খেলুন ও কাটুন","⚔️ ИГРАТЬ И РЕЗАТЬ","⚔️ खेलें और काटें","⚔️ OYNA VE DİLİMLE","⚔️ JUGAR Y CORTAR","⚔️ العب وقطّع","⚔️ MAIN & POTONG"],
        ["⏳ NEXT SLICE:","⏳ পরবর্তী স্লাইস:","⏳ СЛЕДУЮЩИЙ РАЗРЕЗ:","⏳ अगली स्लाइस:","⏳ SONRAKİ DİLİM:","⏳ SIGUIENTE CORTE:","⏳ التقطيع التالي:","⏳ POTONGAN BERIKUTNYA:"],
        ["🎁 Reward:","🎁 পুরস্কার:","🎁 Награда:","🎁 इनाम:","🎁 Ödül:","🎁 Recompensa:","🎁 المكافأة:","🎁 Hadiah:"],
        ["per slice (30m Cooldown)","প্রতি স্লাইসে (৩০ মিনিট কুলডাউন)","за разрез (кулдаун 30м)","प्रति स्लाइस (30 मिनट कूलडाउन)","dilim başına (30dk Bekleme)","por corte (30m de espera)","لكل تقطيعة (تبريد 30 دقيقة)","per potongan (Cooldown 30m)"],
        ["Tasks","টাস্ক","Задания","टास्क","Görevler","Tareas","المهام","Tugas"],
        ["Refer","রেফার","Рефералы","रेफर","Davet Et","Referir","الإحالة","Rujuk"],
        ["Ranking","র‍্যাংকিং","Рейтинг","रैंकिंग","Sıralama","Clasificación","الترتيب","Peringkat"],
        ["Wallet","ওয়ালেট","Кошелёк","वॉलेट","Cüzdan","Billetera","المحفظة","Dompet"],
        ["Ads","বিজ্ঞাপন","Реклама","विज्ञापन","Reklamlar","Anuncios","الإعلانات","Iklan"],
        ["LEVEL","লেভেল","УРОВЕНЬ","लेवल","SEVİYE","NIVEL","المستوى","LEVEL"],
        ["🎉 LEVEL UP! 🎉","🎉 লেভেল আপ! 🎉","🎉 НОВЫЙ УРОВЕНЬ! 🎉","🎉 लेवल अप! 🎉","🎉 SEVİYE ATLADIN! 🎉","🎉 ¡SUBISTE DE NIVEL! 🎉","🎉 ترقية المستوى! 🎉","🎉 NAIK LEVEL! 🎉"],
        ["🎁 Bonus: +25 🍎 Fruit Coin!","🎁 বোনাস: +২৫ 🍎 ফ্রুট কয়েন!","🎁 Бонус: +25 🍎 Fruit Coin!","🎁 बोनस: +25 🍎 फ्रूट कॉइन!","🎁 Bonus: +25 🍎 Fruit Coin!","🎁 Bono: +25 🍎 ¡Fruit Coin!","🎁 مكافأة: +25 🍎 Fruit Coin!","🎁 Bonus: +25 🍎 Fruit Coin!"],
        ["⚔️ SWIPE OR TAP TO SLICE THE BIG FRUIT!","⚔️ বড় ফলটি কাটতে সোয়াইপ বা ট্যাপ করুন!","⚔️ ПРОВЕДИТЕ ИЛИ НАЖМИТЕ, ЧТОБЫ РАЗРЕЗАТЬ БОЛЬШОЙ ФРУКТ!","⚔️ बड़े फल को काटने के लिए स्वाइप या टैप करें!","⚔️ BÜYÜK MEYVEYİ DİLİMLEMEK İÇİN KAYDIR VEYA DOKUN!","⚔️ ¡DESLIZA O TOCA PARA CORTAR LA FRUTA GRANDE!","⚔️ اسحب أو اضغط لتقطيع الفاكهة الكبيرة!","⚔️ GESEK ATAU KETUK UNTUK MEMOTONG BUAH BESAR!"],
        ["🎁 CLAIM REWARD (WATCH AD)","🎁 পুরস্কার নিন (বিজ্ঞাপন দেখুন)","🎁 ЗАБРАТЬ НАГРАДУ (СМОТРЕТЬ РЕКЛАМУ)","🎁 इनाम लें (विज्ञापन देखें)","🎁 ÖDÜLÜ AL (REKLAM İZLE)","🎁 RECLAMAR RECOMPENSA (VER ANUNCIO)","🎁 احصل على المكافأة (شاهد الإعلان)","🎁 KLAIM HADIAH (TONTON IKLAN)"],
        ["🏠 RETURN TO HOME","🏠 হোমে ফিরুন","🏠 НА ГЛАВНУЮ","🏠 होम पर वापस जाएं","🏠 ANA SAYFAYA DÖN","🏠 VOLVER AL INICIO","🏠 العودة إلى الرئيسية","🏠 KEMBALI KE BERANDA"],
        ["⏳ Slice is on 30-minute cooldown!","⏳ স্লাইস ৩০ মিনিটের কুলডাউনে আছে!","⏳ Разрез на кулдауне 30 минут!","⏳ स्लाइस 30 मिनट के कूलडाउन पर है!","⏳ Dilimleme 30 dakikalık bekleme süresinde!","⏳ ¡El corte está en enfriamiento de 30 minutos!","⏳ التقطيع في فترة تبريد لمدة 30 دقيقة!","⏳ Potongan sedang cooldown 30 menit!"],
        ["✂️ Cuts: {0}/{1}","✂️ কাট: {0}/{1}","✂️ Разрезы: {0}/{1}","✂️ कट: {0}/{1}","✂️ Kesim: {0}/{1}","✂️ Cortes: {0}/{1}","✂️ التقطيعات: {0}/{1}","✂️ Potongan: {0}/{1}"],
        ["📺 WATCH AD","📺 বিজ্ঞাপন দেখুন","📺 СМОТРЕТЬ РЕКЛАМУ","📺 विज्ञापन देखें","📺 REKLAM İZLE","📺 VER ANUNCIO","📺 شاهد الإعلان","📺 TONTON IKLAN"],
        ["🏆 Fruit Master Levels","🏆 ফ্রুট মাস্টার লেভেল","🏆 Уровни Fruit Master","🏆 फ्रूट मास्टर लेवल","🏆 Fruit Master Seviyeleri","🏆 Niveles de Fruit Master","🏆 مستويات Fruit Master","🏆 Level Fruit Master"],
        ["Slice fruits to level up! Max Level:","লেভেল আপ করতে ফল কাটুন! সর্বোচ্চ লেভেল:","Режьте фрукты, чтобы повысить уровень! Макс. уровень:","लेवल अप करने के लिए फल काटें! अधिकतम लेवल:","Seviye atlamak için meyve dilimle! Maks. Seviye:","¡Corta frutas para subir de nivel! Nivel máximo:","قطّع الفواكه لترتقي بمستواك! أقصى مستوى:","Potong buah untuk naik level! Level Maks:"],
        [". Each level unlocks milestone bonus 🍎 FC rewards!","। প্রতিটি লেভেলে মাইলস্টোন বোনাস 🍎 FC পুরস্কার আনলক হয়!",". Каждый уровень открывает бонусные 🍎 FC награды!","। हर लेवल पर माइलस्टोन बोनस 🍎 FC इनाम अनलॉक होते हैं!",". Her seviye, kilometre taşı bonus 🍎 FC ödülleri açar!",". ¡Cada nivel desbloquea recompensas de bonificación 🍎 FC!",". كل مستوى يفتح مكافآت 🍎 FC إضافية!",". Setiap level membuka hadiah bonus 🍎 FC!"],
        ["Current:","বর্তমান:","Текущий:","वर्तमान:","Mevcut:","Actual:","الحالي:","Saat ini:"],
        ["CLOSE","বন্ধ করুন","ЗАКРЫТЬ","बंद करें","KAPAT","CERRAR","إغلاق","TUTUP"],
        ["A Gift For You!","তোমার জন্য একটি উপহার!","Подарок для тебя!","आपके लिए एक तोहफ़ा!","Sana Bir Hediye!","¡Un Regalo Para Ti!","هدية لك!","Hadiah Untukmu!"],
        ["🎁 CLAIM GIFT","🎁 উপহার নিন","🎁 ЗАБРАТЬ ПОДАРОК","🎁 गिफ्ट लें","🎁 HEDİYEYİ AL","🎁 RECLAMAR REGALO","🎁 احصل على الهدية","🎁 KLAIM HADIAH"],
        ["👤 Player Profile","👤 প্লেয়ার প্রোফাইল","👤 Профиль игрока","👤 प्लेयर प्रोफ़ाइल","👤 Oyuncu Profili","👤 Perfil del Jugador","👤 ملف اللاعب","👤 Profil Pemain"],
        ["LEVELS 🏆","লেভেল 🏆","УРОВНИ 🏆","लेवल 🏆","SEVİYELER 🏆","NIVELES 🏆","المستويات 🏆","LEVEL 🏆"],
        ["Redeem Promo Code","প্রোমো কোড রিডিম করুন","Активировать промокод","प्रोमो कोड रिडीम करें","Promosyon Kodunu Kullan","Canjear Código Promocional","استبدال كود العرض","Tukar Kode Promo"],
        ["REDEEM","রিডিম করুন","АКТИВИРОВАТЬ","रिडीम करें","KULLAN","CANJEAR","استبدال","TUKAR"],
        ["🏆 Top Rankings","🏆 শীর্ষ র‍্যাংকিং","🏆 Топ рейтинга","🏆 टॉप रैंकिंग","🏆 En İyi Sıralamalar","🏆 Mejores Clasificaciones","🏆 أعلى الترتيبات","🏆 Peringkat Teratas"],
        ["🏆 Top Slicers Leaderboard","🏆 শীর্ষ স্লাইসার লিডারবোর্ড","🏆 Таблица лидеров — лучшие резчики","🏆 टॉप स्लाइसर लीडरबोर्ड","🏆 En İyi Dilimleyiciler Lider Tablosu","🏆 Tabla de los Mejores Cortadores","🏆 لوحة صدارة أفضل المقطّعين","🏆 Papan Peringkat Pemotong Terbaik"],
        ["Top 20 players ranked by Fruit Coin earnings!","ফ্রুট কয়েন আয় অনুযায়ী শীর্ষ ২০ প্লেয়ার!","Топ-20 игроков по заработку Fruit Coin!","फ्रूट कॉइन कमाई के हिसाब से टॉप 20 प्लेयर!","Fruit Coin kazancına göre en iyi 20 oyuncu!","¡Los 20 mejores jugadores según ganancias de Fruit Coin!","أفضل 20 لاعبًا حسب أرباح Fruit Coin!","20 pemain teratas berdasarkan penghasilan Fruit Coin!"],
        ["Loading rankings...","র‍্যাংকিং লোড হচ্ছে...","Загрузка рейтинга...","रैंकिंग लोड हो रही है...","Sıralamalar yükleniyor...","Cargando clasificaciones...","جارٍ تحميل الترتيبات...","Memuat peringkat..."],
        ["💳 Withdraw USDT","💳 USDT উত্তোলন করুন","💳 Вывести USDT","💳 USDT निकालें","💳 USDT Çek","💳 Retirar USDT","💳 سحب USDT","💳 Tarik USDT"],
        ["My Fruit Coin","আমার ফ্রুট কয়েন","Мои Fruit Coin","मेरा फ्रूट कॉइन","Fruit Coin'lerim","Mi Fruit Coin","عملات Fruit Coin الخاصة بي","Fruit Coin Saya"],
        ["⚠️ To unlock withdraw: Complete","⚠️ উত্তোলন আনলক করতে: সম্পূর্ণ করুন","⚠️ Чтобы открыть вывод: выполните","⚠️ निकासी अनलॉक करने के लिए: पूरा करें","⚠️ Çekimi açmak için: Tamamla","⚠️ Para desbloquear el retiro: Completa","⚠️ لفتح السحب: أكمل","⚠️ Untuk membuka penarikan: Selesaikan"],
        ["5 Tasks","৫টি টাস্ক","5 заданий","5 टास्क","5 Görev","5 Tareas","5 مهام","5 Tugas"],
        ["+ Join our","+ জয়েন করুন আমাদের","+ Вступите в наш","+ हमारा जॉइन करें","+ Bize katıl:","+ Únete a nuestro","+ انضم إلى","+ Gabung ke"],
        ["Official Channel &amp; Community","অফিসিয়াল চ্যানেল ও কমিউনিটি","официальный канал и сообщество","ऑफिशियल चैनल और कम्युनिटी","Resmi Kanal ve Topluluk","Canal y Comunidad Oficial","القناة الرسمية والمجتمع","Channel & Komunitas Resmi"],
        ["Rate:","রেট:","Курс:","दर:","Oran:","Tasa:","السعر:","Kurs:"],
        ["Minimum:","সর্বনিম্ন:","Минимум:","न्यूनतम:","Minimum:","Mínimo:","الحد الأدنى:","Minimum:"],
        ["5% fee applies","৫% ফি প্রযোজ্য","Применяется комиссия 5%","5% शुल्क लागू होगा","%5 ücret uygulanır","Se aplica una comisión del 5%","تُطبَّق رسوم 5%","Berlaku biaya 5%"],
        ["TonKeeper Wallet","টনকিপার ওয়ালেট","Кошелёк TonKeeper","TonKeeper वॉलेट","TonKeeper Cüzdanı","Billetera TonKeeper","محفظة TonKeeper","Dompet TonKeeper"],
        ["USDT on TON Network (Direct Transfer)","TON নেটওয়ার্কে USDT (সরাসরি ট্রান্সফার)","USDT в сети TON (прямой перевод)","TON नेटवर्क पर USDT (सीधा ट्रांसफर)","TON Ağında USDT (Doğrudan Transfer)","USDT en la Red TON (Transferencia Directa)","USDT على شبكة TON (تحويل مباشر)","USDT di Jaringan TON (Transfer Langsung)"],
        ["MAX BALANCE","সর্বোচ্চ ব্যালেন্স","МАКС. БАЛАНС","अधिकतम बैलेंस","MAKS BAKİYE","SALDO MÁXIMO","أقصى رصيد","SALDO MAKS"],
        ["After 5% fee, you will receive approximately:","৫% ফি কাটার পর আপনি প্রায় পাবেন:","После комиссии 5% вы получите примерно:","5% शुल्क के बाद, आपको लगभग मिलेगा:","%5 ücretten sonra yaklaşık olarak alacaksın:","Después de la comisión del 5%, recibirás aproximadamente:","بعد رسوم 5%، ستحصل تقريبًا على:","Setelah biaya 5%, kamu akan menerima sekitar:"],
        ["💸 WITHDRAW NOW","💸 এখনই উত্তোলন করুন","💸 ВЫВЕСТИ СЕЙЧАС","💸 अभी निकालें","💸 ŞİMDİ ÇEK","💸 RETIRAR AHORA","💸 اسحب الآن","💸 TARIK SEKARANG"],
        ["Processing: 24-48 hours after review","প্রসেসিং: রিভিউর পর ২৪-৪৮ ঘণ্টা","Обработка: 24-48 часов после проверки","प्रोसेसिंग: समीक्षा के बाद 24-48 घंटे","İşlem: incelemeden sonra 24-48 saat","Procesamiento: 24-48 horas después de la revisión","المعالجة: 24-48 ساعة بعد المراجعة","Proses: 24-48 jam setelah peninjauan"],
        ["📋 Withdraw History","📋 উত্তোলনের ইতিহাস","📋 История выводов","📋 निकासी इतिहास","📋 Çekim Geçmişi","📋 Historial de Retiros","📋 سجل السحب","📋 Riwayat Penarikan"],
        ["▼ Show","▼ দেখান","▼ Показать","▼ दिखाएं","▼ Göster","▼ Mostrar","▼ إظهار","▼ Tampilkan"],
        ["⏳ PENDING","⏳ পেন্ডিং","⏳ В ОБРАБОТКЕ","⏳ पेंडिंग","⏳ BEKLEMEDE","⏳ PENDIENTE","⏳ قيد الانتظار","⏳ MENUNGGU"],
        ["✅ APPROVED","✅ অনুমোদিত","✅ ОДОБРЕНО","✅ स्वीकृत","✅ ONAYLANDI","✅ APROBADO","✅ تمت الموافقة","✅ DISETUJUI"],
        ["👥 Refer & Earn","👥 রেফার করুন ও আয় করুন","👥 Приглашай и зарабатывай","👥 रेफर करें और कमाएं","👥 Davet Et ve Kazan","👥 Refiere y Gana","👥 أحِل واربح","👥 Rujuk & Hasilkan"],
        ["Total Referrals","মোট রেফারেল","Всего рефералов","कुल रेफरल","Toplam Davetler","Total de Referidos","إجمالي الإحالات","Total Rujukan"],
        ["🍎 Fruit Coin Earned","🍎 অর্জিত ফ্রুট কয়েন","🍎 Заработано Fruit Coin","🍎 अर्जित फ्रूट कॉइन","🍎 Kazanılan Fruit Coin","🍎 Fruit Coin Ganado","🍎 عملات Fruit Coin المكتسبة","🍎 Fruit Coin Diperoleh"],
        ["🎁 4-Step Milestone Rewards per Friend:","🎁 প্রতি বন্ধুর জন্য ৪-ধাপের মাইলস্টোন পুরস্কার:","🎁 4-этапные награды за каждого друга:","🎁 हर दोस्त के लिए 4-चरण माइलस्टोन इनाम:","🎁 Her Arkadaş İçin 4 Aşamalı Kilometre Taşı Ödülleri:","🎁 Recompensas de 4 Pasos por Cada Amigo:","🎁 مكافآت من 4 خطوات لكل صديق:","🎁 Hadiah Milestone 4 Langkah per Teman:"],
        ["1️⃣ Join Channels:","1️⃣ চ্যানেলে জয়েন:","1️⃣ Вступление в каналы:","1️⃣ चैनल जॉइन करें:","1️⃣ Kanallara Katıl:","1️⃣ Unirse a Canales:","1️⃣ الانضمام إلى القنوات:","1️⃣ Gabung Channel:"],
        ["Friend verifies official channels","বন্ধু অফিসিয়াল চ্যানেল ভেরিফাই করে","Друг подтверждает вступление в каналы","दोस्त ऑफिशियल चैनल वेरिफाई करता है","Arkadaş resmi kanalları doğrular","El amigo verifica los canales oficiales","يتحقق الصديق من القنوات الرسمية","Teman memverifikasi channel resmi"],
        ["2️⃣ 10 Tasks Done:","2️⃣ ১০টি টাস্ক সম্পন্ন:","2️⃣ Выполнено 10 заданий:","2️⃣ 10 टास्क पूरे:","2️⃣ 10 Görev Tamamlandı:","2️⃣ 10 Tareas Completadas:","2️⃣ إتمام 10 مهام:","2️⃣ 10 Tugas Selesai:"],
        ["Friend completes 10 tasks","বন্ধু ১০টি টাস্ক সম্পন্ন করে","Друг выполняет 10 заданий","दोस्त 10 टास्क पूरे करता है","Arkadaş 10 görevi tamamlar","El amigo completa 10 tareas","يكمل الصديق 10 مهام","Teman menyelesaikan 10 tugas"],
        ["3️⃣ 10 Slash Games:","3️⃣ ১০টি স্ল্যাশ গেম:","3️⃣ 10 игр Slash:","3️⃣ 10 स्लैश गेम:","3️⃣ 10 Kesme Oyunu:","3️⃣ 10 Juegos de Corte:","3️⃣ 10 ألعاب تقطيع:","3️⃣ 10 Game Potong:"],
        ["Friend plays 10 fruit cut games","বন্ধু ১০টি ফ্রুট কাট গেম খেলে","Друг играет в 10 игр Fruit Cut","दोस्त 10 फ्रूट कट गेम खेलता है","Arkadaş 10 fruit cut oyunu oynar","El amigo juega 10 partidas de fruit cut","يلعب الصديق 10 ألعاب فروت كت","Teman bermain 10 game fruit cut"],
        ["4️⃣ Level 3 Master:","4️⃣ লেভেল ৩ মাস্টার:","4️⃣ Мастер 3 уровня:","4️⃣ लेवल 3 मास्टर:","4️⃣ Seviye 3 Ustası:","4️⃣ Maestro Nivel 3:","4️⃣ إتقان المستوى 3:","4️⃣ Master Level 3:"],
        ["Friend reaches Level 3","বন্ধু লেভেল ৩ এ পৌঁছায়","Друг достигает 3 уровня","दोस्त लेवल 3 तक पहुंचता है","Arkadaş Seviye 3'e ulaşır","El amigo alcanza el Nivel 3","يصل الصديق إلى المستوى 3","Teman mencapai Level 3"],
        ["Total reward per complete referral:","প্রতি সম্পূর্ণ রেফারেলের মোট পুরস্কার:","Общая награда за полный реферал:","प्रति पूर्ण रेफरल कुल इनाम:","Tamamlanan her davet için toplam ödül:","Recompensa total por cada referido completo:","إجمالي المكافأة لكل إحالة مكتملة:","Total hadiah per rujukan lengkap:"],
        ["Your Refer Link:","আপনার রেফার লিংক:","Ваша реферальная ссылка:","आपका रेफर लिंक:","Davet Bağlantınız:","Tu Enlace de Referido:","رابط الإحالة الخاص بك:","Link Rujukan Anda:"],
        ["📋 Copy Link","📋 লিংক কপি করুন","📋 Копировать ссылку","📋 लिंक कॉपी करें","📋 Bağlantıyı Kopyala","📋 Copiar Enlace","📋 نسخ الرابط","📋 Salin Link"],
        ["⚙️ Settings","⚙️ সেটিংস","⚙️ Настройки","⚙️ सेटिंग्स","⚙️ Ayarlar","⚙️ Configuración","⚙️ الإعدادات","⚙️ Pengaturan"],
        ["🔑 Your Unique Code","🔑 আপনার ইউনিক কোড","🔑 Ваш уникальный код","🔑 आपका यूनिक कोड","🔑 Benzersiz Kodunuz","🔑 Tu Código Único","🔑 رمزك الفريد","🔑 Kode Unik Anda"],
        ["Tap to copy","কপি করতে ট্যাপ করুন","Нажмите, чтобы скопировать","कॉपी करने के लिए टैप करें","Kopyalamak için dokun","Toca para copiar","اضغط للنسخ","Ketuk untuk menyalin"],
        ["Telegram Username","টেলিগ্রাম ইউজারনেম","Имя пользователя Telegram","टेलीग्राम यूज़रनेम","Telegram Kullanıcı Adı","Nombre de Usuario de Telegram","اسم مستخدم تيليغرام","Username Telegram"],
        ["Sound","সাউন্ড","Звук","साउंड","Ses","Sonido","الصوت","Suara"],
        ["Vibration","ভাইব্রেশন","Вибрация","वाइब्रेशन","Titreşim","Vibración","الاهتزاز","Getaran"],
        ["Version","ভার্সন","Версия","वर्शन","Sürüm","Versión","الإصدار","Versi"],
        ["📺 Earn with Ads","📺 বিজ্ঞাপন দেখে আয় করুন","📺 Зарабатывай на рекламе","📺 विज्ञापन से कमाएं","📺 Reklamlarla Kazan","📺 Gana con Anuncios","📺 اربح من الإعلانات","📺 Hasilkan dari Iklan"],
        ["▶ Watch","▶ দেখুন","▶ Смотреть","▶ देखें","▶ İzle","▶ Ver","▶ شاهد","▶ Tonton"],
        ["Resets daily automatically at 12:00 AM 🕛","প্রতিদিন রাত ১২:০০টায় স্বয়ংক্রিয়ভাবে রিসেট হয় 🕛","Автоматически сбрасывается каждый день в 00:00 🕛","हर दिन रात 12:00 बजे अपने आप रीसेट होता है 🕛","Her gün gece 12:00'de otomatik olarak sıfırlanır 🕛","Se reinicia automáticamente todos los días a las 12:00 AM 🕛","يُعاد الضبط تلقائيًا كل يوم الساعة 12:00 صباحًا 🕛","Reset otomatis setiap hari pukul 00:00 🕛"],
        ["📋 Tasks","📋 টাস্ক","📋 Задания","📋 टास्क","📋 Görevler","📋 Tareas","📋 المهام","📋 Tugas"],
        ["Task Progress","টাস্ক অগ্রগতি","Прогресс заданий","टास्क प्रगति","Görev İlerlemesi","Progreso de Tareas","تقدم المهام","Progres Tugas"],
        ["🔥 Daily","🔥 দৈনিক","🔥 Ежедневно","🔥 दैनिक","🔥 Günlük","🔥 Diario","🔥 يومي","🔥 Harian"],
        ["💎 Exclusive","💎 এক্সক্লুসিভ","💎 Эксклюзив","💎 एक्सक्लूसिव","💎 Özel","💎 Exclusivo","💎 حصري","💎 Eksklusif"],
        ["🤝 Partner","🤝 পার্টনার","🤝 Партнёр","🤝 पार्टनर","🤝 Ortak","🤝 Socio","🤝 شريك","🤝 Mitra"],
        ["Loading tasks...","টাস্ক লোড হচ্ছে...","Загрузка заданий...","टास्क लोड हो रहे हैं...","Görevler yükleniyor...","Cargando tareas...","جارٍ تحميل المهام...","Memuat tugas..."],
        ["Complete tasks to earn Fruit Coin!","ফ্রুট কয়েন আয় করতে টাস্ক সম্পন্ন করুন!","Выполняй задания, чтобы заработать Fruit Coin!","फ्रूट कॉइन कमाने के लिए टास्क पूरे करें!","Fruit Coin kazanmak için görevleri tamamla!","¡Completa tareas para ganar Fruit Coin!","أكمل المهام لتربح Fruit Coin!","Selesaikan tugas untuk mendapatkan Fruit Coin!"],
        ["AD LOADING...","বিজ্ঞাপন লোড হচ্ছে...","ЗАГРУЗКА РЕКЛАМЫ...","विज्ञापन लोड हो रहा है...","REKLAM YÜKLENİYOR...","CARGANDO ANUNCIO...","جارٍ تحميل الإعلان...","MEMUAT IKLAN..."],
        ["Please wait...","অনুগ্রহ করে অপেক্ষা করুন...","Пожалуйста, подождите...","कृपया प्रतीक्षा करें...","Lütfen bekleyin...","Por favor espera...","يرجى الانتظار...","Mohon tunggu..."],
        ["Please open inside Telegram!","অনুগ্রহ করে টেলিগ্রামের ভেতরে খুলুন!","Пожалуйста, откройте внутри Telegram!","कृपया टेलीग्राम के अंदर खोलें!","Lütfen Telegram içinde açın!","¡Por favor abre dentro de Telegram!","يرجى الفتح داخل تيليغرام!","Mohon buka di dalam Telegram!"],
        ["⚠️ Connection failed.","⚠️ সংযোগ ব্যর্থ হয়েছে।","⚠️ Ошибка соединения.","⚠️ कनेक्शन विफल हुआ।","⚠️ Bağlantı başarısız oldu.","⚠️ Falló la conexión.","⚠️ فشل الاتصال.","⚠️ Koneksi gagal."],
        ["Check your internet and try again.","আপনার ইন্টারনেট চেক করে আবার চেষ্টা করুন।","Проверьте интернет и попробуйте снова.","अपना इंटरनेट जांचें और फिर से कोशिश करें।","İnternetini kontrol et ve tekrar dene.","Verifica tu internet e inténtalo de nuevo.","تحقق من الإنترنت وحاول مرة أخرى.","Periksa internet Anda dan coba lagi."],
        ["🔄 TAP TO RETRY","🔄 আবার চেষ্টা করতে ট্যাপ করুন","🔄 НАЖМИТЕ, ЧТОБЫ ПОВТОРИТЬ","🔄 फिर से कोशिश करने के लिए टैप करें","🔄 TEKRAR DENEMEK İÇİN DOKUN","🔄 TOCA PARA REINTENTAR","🔄 اضغط لإعادة المحاولة","🔄 KETUK UNTUK COBA LAGI"],
        ["Buy","কিনুন","Купить","खरीदें","Satın Al","Comprar","شراء","Beli"],
        ["Available","উপলব্ধ","Доступно","उपलब्ध","Mevcut","Disponible","متاح","Tersedia"],
        ["No tasks available right now.","এই মুহূর্তে কোনো টাস্ক নেই।","Сейчас нет доступных заданий.","अभी कोई टास्क उपलब्ध नहीं है।","Şu anda uygun görev yok.","No hay tareas disponibles en este momento.","لا توجد مهام متاحة الآن.","Tidak ada tugas tersedia saat ini."],
        ["⚠️ Could not load history, try again.","⚠️ ইতিহাস লোড করা যায়নি, আবার চেষ্টা করুন।","⚠️ Не удалось загрузить историю, попробуйте снова.","⚠️ इतिहास लोड नहीं हो सका, फिर कोशिश करें।","⚠️ Geçmiş yüklenemedi, tekrar dene.","⚠️ No se pudo cargar el historial, inténtalo de nuevo.","⚠️ تعذّر تحميل السجل، حاول مرة أخرى.","⚠️ Riwayat tidak dapat dimuat, coba lagi."],
        ["No withdrawal history yet.","এখনো কোনো উত্তোলনের ইতিহাস নেই।","Пока нет истории выводов.","अभी तक कोई निकासी इतिहास नहीं है।","Henüz çekim geçmişi yok.","Aún no hay historial de retiros.","لا يوجد سجل سحب حتى الآن.","Belum ada riwayat penarikan."],
        ["Could not load history.","ইতিহাস লোড করা যায়নি।","Не удалось загрузить историю.","इतिहास लोड नहीं हो सका।","Geçmiş yüklenemedi.","No se pudo cargar el historial.","تعذّر تحميل السجل.","Riwayat tidak dapat dimuat."],
        ["ACTIVE","সক্রিয়","АКТИВНО","सक्रिय","AKTİF","ACTIVO","نشط","AKTIF"],
        ["✅ DONE","✅ সম্পন্ন","✅ ГОТОВО","✅ पूर्ण","✅ TAMAMLANDI","✅ HECHO","✅ تم","✅ SELESAI"],
        ["⚠️ Loading took too long.","⚠️ লোড হতে বেশি সময় লাগছে।","⚠️ Загрузка заняла слишком много времени.","⚠️ लोड होने में बहुत समय लग रहा है।","⚠️ Yükleme çok uzun sürdü.","⚠️ La carga tardó demasiado.","⚠️ استغرق التحميل وقتًا طويلاً جدًا.","⚠️ Pemuatan terlalu lama."],
        ["Please check your internet.","অনুগ্রহ করে আপনার ইন্টারনেট চেক করুন।","Пожалуйста, проверьте интернет.","कृपया अपना इंटरनेट जांचें।","Lütfen internetini kontrol et.","Por favor verifica tu internet.","يرجى التحقق من الإنترنت.","Mohon periksa internet Anda."],
        ["Watching Ad...","বিজ্ঞাপন দেখা হচ্ছে...","Просмотр рекламы...","विज्ञापन देखा जा रहा है...","Reklam izleniyor...","Viendo anuncio...","جارٍ مشاهدة الإعلان...","Menonton iklan..."],
        ["Opening Box...","বক্স খোলা হচ্ছে...","Открытие сундука...","बॉक्स खोला जा रहा है...","Kutu açılıyor...","Abriendo cofre...","جارٍ فتح الصندوق...","Membuka kotak..."],
        ["Loading top players...","শীর্ষ প্লেয়ার লোড হচ্ছে...","Загрузка лучших игроков...","टॉप प्लेयर लोड हो रहे हैं...","En iyi oyuncular yükleniyor...","Cargando mejores jugadores...","جارٍ تحميل أفضل اللاعبين...","Memuat pemain terbaik..."],
        ["(YOU)","(আপনি)","(ВЫ)","(आप)","(SEN)","(TÚ)","(أنت)","(ANDA)"],
        ["No rankings available yet.","এখনো কোনো র‍্যাংকিং নেই।","Пока нет доступных рейтингов.","अभी कोई रैंकिंग उपलब्ध नहीं है।","Henüz sıralama yok.","Aún no hay clasificaciones disponibles.","لا توجد ترتيبات متاحة بعد.","Belum ada peringkat tersedia."],
        ["Novice Slicer","নভিস স্লাইসার","Новичок-резчик","नौसिखिया स्लाइसर","Acemi Dilimleyici","Cortador Novato","مبتدئ التقطيع","Pemotong Pemula"],
        ["Novice Slicer 🍎","নভিস স্লাইসার 🍎","Новичок-резчик 🍎","नौसिखिया स्लाइसर 🍎","Acemi Dilimleyici 🍎","Cortador Novato 🍎","مبتدئ التقطيع 🍎","Pemotong Pemula 🍎"],
        ["Fruit Peeler","ফ্রুট পিলার","Чистильщик фруктов","फ्रूट पीलर","Meyve Soyucu","Pelador de Frutas","مقشّر الفاكهة","Pengupas Buah"],
        ["Fruit Peeler 🍊","ফ্রুট পিলার 🍊","Чистильщик фруктов 🍊","फ्रूट पीलर 🍊","Meyve Soyucu 🍊","Pelador de Frutas 🍊","مقشّر الفاكهة 🍊","Pengupas Buah 🍊"],
        ["Juice Maker","জুস মেকার","Соковыжималка","जूस मेकर","Meyve Suyu Yapımcısı","Hacedor de Jugos","صانع العصير","Pembuat Jus"],
        ["Juice Maker 🍋","জুস মেকার 🍋","Соковыжималка 🍋","जूस मेकर 🍋","Meyve Suyu Yapımcısı 🍋","Hacedor de Jugos 🍋","صانع العصير 🍋","Pembuat Jus 🍋"],
        ["Kitchen Apprentice","কিচেন অ্যাপ্রেন্টিস","Ученик на кухне","किचन अप्रेंटिस","Mutfak Çırağı","Aprendiz de Cocina","متدرب المطبخ","Magang Dapur"],
        ["Kitchen Apprentice 🍇","কিচেন অ্যাপ্রেন্টিস 🍇","Ученик на кухне 🍇","किचन अप्रेंटिस 🍇","Mutfak Çırağı 🍇","Aprendiz de Cocina 🍇","متدرب المطبخ 🍇","Magang Dapur 🍇"],
        ["Fruit Carver","ফ্রুট কার্ভার","Резчик по фруктам","फ्रूट कार्वर","Meyve Oymacısı","Tallador de Frutas","نحّات الفاكهة","Pengukir Buah"],
        ["Fruit Carver 🍓","ফ্রুট কার্ভার 🍓","Резчик по фруктам 🍓","फ्रूट कार्वर 🍓","Meyve Oymacısı 🍓","Tallador de Frutas 🍓","نحّات الفاكهة 🍓","Pengukir Buah 🍓"],
        ["Fast Blade","ফাস্ট ব্লেড","Быстрый клинок","फास्ट ब्लेड","Hızlı Kılıç","Cuchilla Rápida","النصل السريع","Bilah Cepat"],
        ["Fast Blade 🍑","ফাস্ট ব্লেড 🍑","Быстрый клинок 🍑","फास्ट ब्लेड 🍑","Hızlı Kılıç 🍑","Cuchilla Rápida 🍑","النصل السريع 🍑","Bilah Cepat 🍑"],
        ["Samurai Novice","সামুরাই নভিস","Начинающий самурай","समुराई नौसिखिया","Acemi Samuray","Samurái Novato","ساموراي مبتدئ","Samurai Pemula"],
        ["Samurai Novice 🍒","সামুরাই নভিস 🍒","Начинающий самурай 🍒","समुराई नौसिखिया 🍒","Acemi Samuray 🍒","Samurái Novato 🍒","ساموراي مبتدئ 🍒","Samurai Pemula 🍒"],
        ["Combo Striker","কম্বো স্ট্রাইকার","Комбо-боец","कॉम्बो स्ट्राइकर","Kombo Vurucu","Golpeador Combo","مهاجم الكومبو","Penyerang Combo"],
        ["Combo Striker 🥝","কম্বো স্ট্রাইকার 🥝","Комбо-боец 🥝","कॉम्बो स्ट्राइकर 🥝","Kombo Vurucu 🥝","Golpeador Combo 🥝","مهاجم الكومبو 🥝","Penyerang Combo 🥝"],
        ["Ninja Warrior","নিনজা ওয়ারিয়র","Воин-ниндзя","निंजा वॉरियर","Ninja Savaşçı","Guerrero Ninja","محارب النينجا","Prajurit Ninja"],
        ["Ninja Warrior 🍍","নিনজা ওয়ারিয়র 🍍","Воин-ниндзя 🍍","निंजा वॉरियर 🍍","Ninja Savaşçı 🍍","Guerrero Ninja 🍍","محارب النينجا 🍍","Prajurit Ninja 🍍"],
        ["Master Slicer","মাস্টার স্লাইসার","Мастер-резчик","मास्टर स्लाइसर","Usta Dilimleyici","Cortador Maestro","أستاذ التقطيع","Pemotong Master"],
        ["Master Slicer 🥥","মাস্টার স্লাইসার 🥥","Мастер-резчик 🥥","मास्टर स्लाइसर 🥥","Usta Dilimleyici 🥥","Cortador Maestro 🥥","أستاذ التقطيع 🥥","Pemotong Master 🥥"],
        ["Dojo Master","দোজো মাস্টার","Мастер додзё","डोजो मास्टर","Dojo Ustası","Maestro del Dojo","سيد الدوجو","Master Dojo"],
        ["Dojo Master 🍉","দোজো মাস্টার 🍉","Мастер додзё 🍉","डोजो मास्टर 🍉","Dojo Ustası 🍉","Maestro del Dojo 🍉","سيد الدوجو 🍉","Master Dojo 🍉"],
        ["Shadow Blade","শ্যাডো ব্লেড","Теневой клинок","शैडो ब्लेड","Gölge Kılıç","Cuchilla Sombra","نصل الظل","Bilah Bayangan"],
        ["Shadow Blade 🥭","শ্যাডো ব্লেড 🥭","Теневой клинок 🥭","शैडो ब्लेड 🥭","Gölge Kılıç 🥭","Cuchilla Sombra 🥭","نصل الظل 🥭","Bilah Bayangan 🥭"],
        ["Fruit Titan","ফ্রুট টাইটান","Титан фруктов","फ्रूट टाइटन","Meyve Titanı","Titán de Frutas","عملاق الفاكهة","Titan Buah"],
        ["Fruit Titan 🍈","ফ্রুট টাইটান 🍈","Титан фруктов 🍈","फ्रूट टाइटन 🍈","Meyve Titanı 🍈","Titán de Frutas 🍈","عملاق الفاكهة 🍈","Titan Buah 🍈"],
        ["Legend Slicer","লিজেন্ড স্লাইসার","Легендарный резчик","लीजेंड स्लाइसर","Efsane Dilimleyici","Cortador Legendario","أسطورة التقطيع","Pemotong Legendaris"],
        ["Legend Slicer ⭐","লিজেন্ড স্লাইসার ⭐","Легендарный резчик ⭐","लीजेंड स्लाइसर ⭐","Efsane Dilimleyici ⭐","Cortador Legendario ⭐","أسطورة التقطيع ⭐","Pemotong Legendaris ⭐"],
        ["Grandmaster God","গ্র্যান্ডমাস্টার গড","Бог-гроссмейстер","ग्रैंडमास्टर गॉड","Büyük Usta Tanrı","Dios Gran Maestro","إله الأستاذية الكبرى","Dewa Grandmaster"],
        ["Grandmaster God 👑","গ্র্যান্ডমাস্টার গড 👑","Бог-гроссмейстер 👑","ग्रैंडमास्टर गॉड 👑","Büyük Usta Tanrı 👑","Dios Gran Maestro 👑","إله الأستاذية الكبرى 👑","Dewa Grandmaster 👑"],
        ["Language","ভাষা","Язык","भाषा","Dil","Idioma","اللغة","Bahasa"],
        ["Choose your language","আপনার ভাষা নির্বাচন করুন","Выберите язык","अपनी भाषा चुनें","Dilinizi seçin","Elige tu idioma","اختر لغتك","Pilih bahasa Anda"],
        ["{0} Slices","{0}টি স্লাইস","{0} разрезов","{0} स्लाइस","{0} Dilim","{0} Cortes","{0} تقطيعة","{0} Potongan"],
        ["Need {0} Slices","{0}টি স্লাইস প্রয়োজন","Нужно {0} разрезов","{0} स्लाइस चाहिए","{0} Dilim Gerekli","Necesitas {0} Cortes","يلزم {0} تقطيعة","Butuh {0} Potongan"],
        ["Tasks: {0}/5","টাস্ক: {0}/5","Задания: {0}/5","टास्क: {0}/5","Görevler: {0}/5","Tareas: {0}/5","المهام: {0}/5","Tugas: {0}/5"],
        ["{0}/{1} remaining","{0}/{1} বাকি","Осталось {0}/{1}","{0}/{1} शेष","{0}/{1} kaldı","{0}/{1} restantes","{0}/{1} متبقٍ","{0}/{1} tersisa"],
        ["Lv. {0}","লেভেল {0}","Ур. {0}","लेवल {0}","Sv. {0}","Nv. {0}","المستوى {0}","Lv. {0}"],
        ["MAX LEVEL REACHED","সর্বোচ্চ লেভেলে পৌঁছেছেন","ДОСТИГНУТ МАКС. УРОВЕНЬ","अधिकतम लेवल पूरा हुआ","MAKSİMUM SEVİYEYE ULAŞILDI","NIVEL MÁXIMO ALCANZADO","تم الوصول إلى أقصى مستوى","LEVEL MAKS TERCAPAI"],    ];

    function norm(s) { return s.replace(/\s+/g, ' ').trim(); }
    function esc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

    var EXACT = {};
    var PATTERNS = {};
    CODES.forEach(function (c) { EXACT[c] = Object.create(null); PATTERNS[c] = []; });

    DICTIONARY.forEach(function (row) {
        var en = norm(row[0]);
        CODES.forEach(function (code, i) {
            var out = row[i + 1];
            if (out === undefined || out === null || out === '') return;
            // Arabic: an en-dash between two numbers renders reversed in RTL text.
            if (code === 'ar') out = out.replace(/\{0\}–\{1\}/g, '{0} إلى {1}');
            if (/\{\d+\}/.test(en)) {
                var re = new RegExp('^' + esc(en).replace(/\\\{(\d+)\\\}/g, '(.*?)') + '$', 's');
                PATTERNS[code].push({ re: re, out: out, weight: en.replace(/\{\d+\}/g, '').length });
            } else {
                EXACT[code][en] = out;
            }
        });
    });
    CODES.forEach(function (c) { PATTERNS[c].sort(function (a, b) { return b.weight - a.weight; }); });

    function fill(tpl, m) { return tpl.replace(/\{(\d+)\}/g, function (_, n) { return m[+n + 1] !== undefined ? m[+n + 1] : ''; }); }

    // Translate one English string to `code`. Returns the same string if unknown.
    function tr(text, code) {
        if (code === 'en' || !EXACT[code]) return text;
        var key = norm(text);
        if (!key || !/[A-Za-z]/.test(key)) return text;
        var hit = EXACT[code][key];
        if (hit !== undefined) return hit;
        var list = PATTERNS[code];
        for (var i = 0; i < list.length; i++) {
            var m = list[i].re.exec(key);
            if (m) return fill(list[i].out, m);
        }
        return text;
    }

    // ── state ──
    var current = 'en';
    function detect() {
        try { var saved = localStorage.getItem(STORAGE_KEY); if (saved && LANGS[saved]) return saved; } catch (e) { /* storage blocked */ }
        try {
            var lc = (window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.initDataUnsafe && window.Telegram.WebApp.initDataUnsafe.user && window.Telegram.WebApp.initDataUnsafe.user.language_code) || navigator.language || 'en';
            lc = String(lc).toLowerCase().slice(0, 2);
            if (LANGS[lc]) return lc;
        } catch (e) { /* ignore */ }
        return 'en';
    }

    // ── DOM translation ──
    var TEXT_ORIG = new WeakMap();   // Text node  → { src, out }
    var ATTR_ORIG = new WeakMap();   // Element    → { attr: { src, out } }
    var ATTRS = ['placeholder', 'title', 'aria-label'];
    var SKIP = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEXTAREA: 1, CODE: 0 };

    function lead(s) { return s.match(/^\s*/)[0]; }
    function trail(s) { return s.match(/\s*$/)[0]; }

    function doText(node) {
        var p = node.parentNode;
        if (!p || SKIP[p.nodeName]) return;
        var rec = TEXT_ORIG.get(node);
        var val = node.nodeValue;
        var src = (rec && rec.out === val) ? rec.src : val;       // unchanged since we wrote it → keep English source
        if (current === 'en') {
            if (rec && rec.out === val && src !== val) node.nodeValue = src;
            TEXT_ORIG.delete(node);
            return;
        }
        if (!/[A-Za-z]/.test(src)) { if (rec) TEXT_ORIG.delete(node); return; }
        var out = tr(src, current);
        if (out === src) { if (rec) TEXT_ORIG.delete(node); return; }
        var finalVal = lead(src) + out + trail(src);
        TEXT_ORIG.set(node, { src: src, out: finalVal });
        if (node.nodeValue !== finalVal) node.nodeValue = finalVal;
    }

    function doAttr(el, attr) {
        var val = el.getAttribute(attr);
        if (val == null) return;
        var map = ATTR_ORIG.get(el) || {};
        var rec = map[attr];
        var src = (rec && rec.out === val) ? rec.src : val;
        if (current === 'en') {
            if (rec && rec.out === val && src !== val) el.setAttribute(attr, src);
            if (rec) { delete map[attr]; }
            return;
        }
        var out = tr(src, current);
        if (out === src) { if (rec) delete map[attr]; return; }
        map[attr] = { src: src, out: out };
        ATTR_ORIG.set(el, map);
        if (val !== out) el.setAttribute(attr, out);
    }

    function walk(root) {
        if (!root) return;
        if (root.nodeType === 3) { doText(root); return; }
        if (root.nodeType !== 1 || SKIP[root.nodeName]) return;
        ATTRS.forEach(function (a) { if (root.hasAttribute && root.hasAttribute(a)) doAttr(root, a); });
        var w = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, null);
        var n;
        while ((n = w.nextNode())) {
            if (n.nodeType === 3) doText(n);
            else if (!SKIP[n.nodeName]) ATTRS.forEach(function (a) { if (n.hasAttribute(a)) doAttr(n, a); });
        }
    }

    var observer = null;
    function startObserver() {
        if (observer || !document.body) return;
        observer = new MutationObserver(function (muts) {
            for (var i = 0; i < muts.length; i++) {
                var m = muts[i];
                if (m.type === 'childList') { for (var j = 0; j < m.addedNodes.length; j++) walk(m.addedNodes[j]); }
                else if (m.type === 'characterData') doText(m.target);
                else if (m.type === 'attributes') doAttr(m.target, m.attributeName);
            }
        });
        observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
    }

    function applyDirection() {
        var de = document.documentElement;
        de.setAttribute('lang', current);
        de.setAttribute('dir', LANGS[current].dir);
    }

    var listeners = [];
    function setLang(code, silent) {
        if (!LANGS[code]) code = 'en';
        current = code;
        try { localStorage.setItem(STORAGE_KEY, code); } catch (e) { /* storage blocked */ }
        applyDirection();
        walk(document.body);
        if (!silent) listeners.forEach(function (cb) { try { cb(code); } catch (e) { /* ignore */ } });
    }

    // Translate from JS code — {0}-style args are substituted after lookup.
    function t(key) {
        var args = Array.prototype.slice.call(arguments, 1);
        var out = tr(key, current);
        if (out === key && args.length) out = key;
        return out.replace(/\{(\d+)\}/g, function (_, n) { return args[+n] !== undefined ? args[+n] : ''; });
    }

    window.i18n = {
        LANGS: LANGS,
        LANG_ORDER: LANG_ORDER,
        lang: function () { return current; },
        setLang: setLang,
        onChange: function (cb) { listeners.push(cb); },
        t: t,
        tr: function (s) { return tr(s, current); },
        // Debug helper: after browsing the app in another language, call
        // i18n.missing() in the console to list every visible English string
        // that still has no translation.
        missing: function () {
            var out = {};
            var w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null), n;
            while ((n = w.nextNode())) {
                var p = n.parentNode; if (!p || SKIP[p.nodeName]) continue;
                var rec = TEXT_ORIG.get(n);
                if (rec && rec.out === n.nodeValue) continue;
                var s = norm(n.nodeValue);
                if (/[A-Za-z]{3,}/.test(s) && current !== 'en' && tr(s, current) === s) out[s] = 1;
            }
            return Object.keys(out);
        },
    };

    current = detect();
    applyDirection();
    startObserver();
    walk(document.body);

    // Build the language-switcher dropdown once the DOM is ready.
    function buildSwitcher() {
        var btn = document.getElementById('lang-switch-btn');
        var modal = document.getElementById('language-modal');
        var list = document.getElementById('language-modal-list');
        if (!btn || !modal || !list) return;
        list.innerHTML = '';
        LANG_ORDER.forEach(function (code) {
            var l = LANGS[code];
            var row = document.createElement('div');
            row.className = 'mrow ptr lang-row';
            row.setAttribute('data-lang', code);
            row.innerHTML = '<span class="mrow-label">' + l.flag + ' ' + l.name + '</span><span class="lang-check">✓</span>';
            row.onclick = function () {
                setLang(code);
                if (window.hideModal) window.hideModal('language-modal');
            };
            list.appendChild(row);
        });
        function refreshCheck() {
            var rows = list.querySelectorAll('.lang-row');
            rows.forEach(function (r) {
                r.classList.toggle('lang-row-active', r.getAttribute('data-lang') === current);
            });
            var flagEl = document.getElementById('lang-switch-flag');
            if (flagEl) flagEl.textContent = LANGS[current].flag;
        }
        refreshCheck();
        listeners.push(refreshCheck);
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', buildSwitcher);
    } else {
        buildSwitcher();
    }
})();
