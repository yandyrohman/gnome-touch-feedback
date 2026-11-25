// Semua yang bisa diatur ada di sini. Habis ubah: jalankan ./install.sh lalu logout-login.

export const TAP = {
    color: 'rgba(255, 255, 255, 0.35)',
    border: 'rgba(0, 0, 0, 0.25)',
    dotSize: 22,            // titik saat jari nempel
    rippleSize: 36,         // lingkaran saat tap dilepas
    rippleScale: 2.2,
    rippleDuration: 380,    // ms
    swipeThreshold: 14,     // px gerak sebelum dianggap swipe
};

export const BRUSH = {
    width: 14,              // tebal kuas paling tebal (px)
    tail: 260,              // ms: seberapa panjang ekor kuas
    color: [1, 1, 1, 0.85],         // RGBA 0..1
    shadow: [0, 0, 0, 0.30],        // garis tepi biar kelihatan di latar terang
};

export const SOUND = {
    enabled: true,          // bunyi klik saat tap dilepas (swipe tanpa suara)
    minGapUs: 40000,        // multi-jari nggak bunyi dobel
};

// Swipe dari bezel bawah: tengah = dock, kiri/kanan = keyboard layar.
// Lebar zona tengah sebagai fraksi lebar layar.
export const EDGES = {
    centerZone: 0.4,
};

export const OSK = {
    floating: true,
    defaultWidth: 0.55,     // fraksi lebar layar
    defaultAspect: 0.40,    // tinggi = lebar * ini
    defaultBottom: 24,      // jarak dari bawah layar (px)
    minWidth: 420,
    minHeight: 180,
    showDuration: 260,      // ms animasi slide up
    hideDuration: 200,
};
