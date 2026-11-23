// نقطة تسجيل أحداث Socket.IO. ستُضاف أحداث الغرف واللعبة هنا في المرحلة 2.
export function registerSockets(io) {
  io.on('connection', (socket) => {
    socket.emit('server:hello', { message: 'مرحبًا من خادم بين بين', id: socket.id });

    socket.on('ping:client', (cb) => {
      if (typeof cb === 'function') cb({ ok: true, at: Date.now() });
    });
  });
}
