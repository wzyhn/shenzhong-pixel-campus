const form = document.querySelector('form');
const output = document.querySelector('output');

async function showSession(options) {
  try {
    const response = await fetch('/api/campus/session', options);
    if (!response.ok) {
      output.textContent = '存档请求未成功（' + response.status + '）';
      return;
    }
    const { user } = await response.json();
    output.textContent = user ? '已登录 · ' + user.nickname : '可输入测试昵称体验本地存档。';
    form.hidden = Boolean(user);
  } catch {
    output.textContent = '无法连接样例 API。';
  }
}
form.addEventListener('submit', (event) => {
  event.preventDefault();
  void showSession({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ nickname: document.querySelector('input').value }),
  });
});
void showSession();
