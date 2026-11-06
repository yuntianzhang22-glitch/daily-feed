const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ranked, cleanTopics, WEIGHTS, VERSION } = require('../desktop/core/ranking');
const NOW = Date.UTC(2026, 10, 6, 12);
const tweet = (id, text, extra = {}) => ({ id: String(id), text, createdAt: new Date(NOW - 3600000).toISOString(), author: { userName: 'sample' }, ...extra });
test('具体方法与低热度专业内容可排在空泛高热度帖前；无作者基准时热度中性', () => {
 const result = ranked([tweet(1, 'Amazing AI!!!', { likeCount: 999999 }), tweet(2, 'AI research: our method includes evaluation results, limitations and a case study in production.', {likeCount:10})], { now: NOW, topics: ['AI'], diversify: false });
 assert.equal(result[0].id, '2');
 assert.ok(result.every(r => r.ranking.features.engagement === 0.5));
 assert.equal(Object.values(WEIGHTS).reduce((a,b)=>a+b),100);
});
test('引用参与评分；链接数量和正文长度不能机械刷分；无链接的一手发布有来源线索', () => {
 const quote = tweet(1, 'Interesting', { quoted_tweet: tweet(2, 'Our research method includes experiments, results and limitations.') });
 const result = ranked([tweet(3, 'Amazing '.repeat(500)), quote, tweet(4, "I'm joining a new product team.")], {now:NOW, diversify:false});
 assert.ok(result.find(r=>r.id==='1').ranking.score > result.find(r=>r.id==='3').ranking.score);
 assert.ok(result.find(r=>r.id==='4').ranking.features.sources > 0.2);
 assert.equal(quote.text, 'Interesting');
});
test('去重不修改原始列表，同论文不同解读保留，同一原帖转推合并', () => {
 const original = tweet(1,'A concrete method and example with evaluation results and limitations.');
 const records = [original, tweet(2,'retweet', {retweeted_tweet:original}), tweet(3,'I disagree because the method overlooks a major limitation.'), tweet(4,'This method is useful in production because it solves our evaluation problem.')];
 const result = ranked(records, {now:NOW, diversify:false});
 assert.equal(result.length,3); assert.equal(records.length,4);
 assert.ok(result.some(r=>r.ranking.duplicate_count===1));
 assert.ok(!('ranking' in original));
});
test('主题匹配遵守英文词边界；无主题中性；未来或缺失日期不能变成最高时效', () => {
 assert.deepEqual(cleanTopics('AI，产品, ai'),['ai','产品']);
 const rows=ranked([tweet(1,'chair'),tweet(2,'AI research'),tweet(3,'AI research news',{createdAt:'invalid'}),tweet(4,'AI news',{createdAt:new Date(NOW+86400000).toISOString()})],{now:NOW,topics:['ai'],diversify:false});
 assert.equal(rows.find(r=>r.id==='1').ranking.features.relevance,0);
 assert.equal(rows.find(r=>r.id==='2').ranking.features.relevance,1);
 assert.equal(rows.find(r=>r.id==='3').ranking.features.freshness,0.5);
 assert.equal(rows.find(r=>r.id==='4').ranking.features.freshness,0.5);
 assert.equal(ranked([tweet(1,'anything')],{now:NOW})[0].ranking.features.relevance,0.5);
});
test('作者多样性施加可解释惩罚；广告之外普通产品发布不直接扣分', () => {
 const rows=ranked([tweet(1,'Introducing a new product with results.'),tweet(2,'Introducing another product with results.'),tweet(3,'Introducing another new product with results.',{author:{userName:'other'}})],{now:NOW,deduplicate:false});
 assert.equal(rows[1].author.userName,'other');
 assert.equal(rows[2].ranking.diversity_penalty,10);
 assert.equal(rows[0].ranking.noise_penalty,0);
 assert.equal(ranked([tweet(4,'Like and retweet for our giveaway')],{now:NOW})[0].ranking.noise_penalty,20);
 assert.ok(rows.every(r=>Number.isFinite(r.ranking.score)&&r.ranking.version===VERSION));
});
test('SQLite精选先在候选池排序再截断，保留全部和状态，不依赖最先返回的20条', () => {
 const {Store}=require('../desktop/core/store');const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ranking-store-')),store=new Store(path.join(dir,'tweets.db'));
 try {
 for(let i=1;i<=30;i++)store.save(tweet(i,i===30?'Detailed research method, evaluation results and limitations in production.':'short update '+i),'user:sample',new Date(NOW).toISOString());
 store.setFlag(['30'],'starred',true);
 const rows=store.list({selected:true,limit:20});assert.ok(rows.some(r=>r.id==='30'));
 assert.equal(store.counts().total,30);assert.equal(store.list({starred:true})[0].id,'30');
 assert.ok(rows.every(r=>r.ranking));
 } finally {store.close();fs.rmSync(dir,{recursive:true,force:true});}
});
test('抓取先评估已返回候选再按作者截断；不增加调用，也不把临时评分写进原始数据',async()=>{
 const {collectFollowGroup}=require('../desktop/core/fetcher');let calls=0;const saved=[];
 const client={async *search(){calls++;yield[tweet(1,'nice'),tweet(2,'Our research method includes a case study, results and limitations.')]}};
 await collectFollowGroup(client,{getState:()=>null,setState:()=>{},save:t=>{saved.push(t);return true;}},['sample'],{max_per_target:1},new Date(NOW).toISOString(),NOW);
 assert.equal(calls,1);assert.equal(saved[0].id,'2');assert.ok(!('ranking'in saved[0]));
});


test('同一引用的不同解读、不同数字和不同图片不被相似文本误合并；主题词支持明确AI别名', () => {
 const quote=tweet(99,'A very long shared study with methods, experiments, evaluation, results, data and limitations. '.repeat(8));
 const rows=ranked([tweet(1,'I disagree because this ignores our production failures.',{quoted_tweet:quote}),tweet(2,'A useful guide for our team to adopt the workflow.',{quoted_tweet:quote})],{now:NOW});
 assert.equal(rows.length,2);
 const version='Introducing our model with an evaluation method, experiment results and important production limitations. Version ';
 assert.equal(ranked([tweet(3,version+'1'),tweet(4,version+'2')],{now:NOW}).length,2);
 assert.equal(ranked([tweet(5,'ChatGPT Images upgraded')],{now:NOW,topics:['AI']})[0].ranking.features.relevance,1);
});

test('关键词抓取在首个已返回页面内优选，不为排序增加接口页数', async()=>{
 const {collectKeyword}=require('../desktop/core/fetcher');const saved=[];let pages=0;
 const client={async *search(){pages++;yield[tweet(1,'nice'),tweet(2,'Research method with evaluation results and limitations.')];pages++;yield[tweet(3,'later')];}};
 await collectKeyword(client,{getState:()=>null,setState:()=>{},save:t=>{saved.push(t);return true;}},'research',{max_per_target:1,max_pages:2},new Date(NOW).toISOString(),NOW);
 assert.equal(saved[0].id,'2');assert.equal(pages,1);
});

test('异常互动量不传播 NaN 或 Infinity，不能破坏整批排序',()=>{
 const rows=ranked(Array.from({length:8},(_,i)=>tweet(i,'AI research result '+i,{likeCount:i%2?Infinity:'invalid'})),{now:NOW,deduplicate:false});
 assert.ok(rows.every(r=>Number.isFinite(r.ranking.score)));
});
