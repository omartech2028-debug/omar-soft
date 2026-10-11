/* عامل خدمة بسيط: يسمح بتثبيت المنصة كتطبيق على الهاتف — لا يخزّن أي بيانات */
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });
