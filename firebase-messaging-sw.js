// Firebase Cloud Messaging Service Worker
// iOS は PWA をホーム画面に追加した状態でのみ通知を受け取れます（iOS 16.4+）。
importScripts('https://www.gstatic.com/firebasejs/10.13.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.13.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyDeG2WPHnotn7NTGubaemGxilbtI9YtEAE",
  authDomain: "genba-kanri-963a8.firebaseapp.com",
  databaseURL: "https://genba-kanri-963a8-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "genba-kanri-963a8",
  storageBucket: "genba-kanri-963a8.firebasestorage.app",
  messagingSenderId: "3828255104",
  appId: "1:3828255104:web:ea0a05e38c8cd9673e5965"
});

var messaging = firebase.messaging();

// バックグラウンド受信。data ペイロードのみの場合に通知を出す。
// （notification ペイロード付きで送ると FCM が自動表示するため、重複表示を避ける）
messaging.onBackgroundMessage(function(payload) {
  var d = payload && payload.data ? payload.data : {};
  var title = d.title || '現場管理';
  var options = {
    body: d.body || '',
    icon: 'icons/icon-192.png',
    badge: 'icons/icon-192.png',
    tag: d.tag || 'genba-kanri',
    data: { url: d.url || './' }
  };
  return self.registration.showNotification(title, options);
});

// 通知タップ時：アプリを前面化して該当 URL を開く
self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  var target = (event.notification.data && event.notification.data.url) || './';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(list) {
      for (var i = 0; i < list.length; i++) {
        var c = list[i];
        if (c.url.indexOf(target) !== -1 && 'focus' in c) return c.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(target);
    })
  );
});
