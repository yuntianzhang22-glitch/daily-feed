// 可公开的合成帖子，不依赖某台电脑上的真实阅读记录。
function xDate(ms) {
  const [day, date, month, year, time] = new Date(ms).toUTCString().split(' ');
  return `${day.slice(0, 3)} ${month} ${date} ${time} +0000 ${year}`;
}
function sampleTweets(names = ['karpathy', 'simonw', 'emollick'], now = Date.now()) {
  return names.flatMap((name, n) => Array.from({ length: 3 }, (_, i) => {
    const id = String(8000000000000000000n + BigInt(Math.floor(now / 1000)) * 10000n + BigInt(n * 10 + i));
    const author = { userName: name, name: `${name} · 示例`, profilePicture: '' };
    return {
      id, author, url: `https://x.com/${name}/status/${id}`,
      text: [
        '【验收样例】把值得关注的信息集中到一个安静的阅读流。可以试试收藏、已读和搜索。',
        '【验收样例】这是一次产品实验：减少重复操作，让每次打开都能找到新的内容。',
        '【验收样例】引用帖也会展示在卡片中。这里的数据是合成的，方便在新电脑上复现。',
      ][i],
      createdAt: xDate(now - (n * 3 + i) * 3600000),
      likeCount: 100 + n * 50 + i * 10, retweetCount: 12, replyCount: 5, viewCount: 2048,
      ...(i === 2 ? { quoted_tweet: {
        id: `${id}1`, text: '【被引用的样例】从用户的实际工作出发设计工具。', author,
        url: `https://x.com/${name}/status/${id}1`, createdAt: xDate(now),
      } } : {}),
    };
  }));
}
module.exports = { sampleTweets };
