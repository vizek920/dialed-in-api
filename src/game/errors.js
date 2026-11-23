// خطأ متوقع في اللعبة: يحمل رمزًا تفهمه الواجهة (مثل team_full)
export class GameError extends Error {
  constructor(code) {
    super(code);
    this.name = 'GameError';
    this.code = code;
  }
}

export const fail = (code) => {
  throw new GameError(code);
};
