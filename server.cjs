const http=require('node:http'), fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),os=require('node:os');
const {DatabaseSync}=require('node:sqlite');
const dir=process.env.STUDIO_DATA||path.join(os.homedir(),'.munjang-classroom');fs.mkdirSync(dir,{recursive:true});
const db=new DatabaseSync(path.join(dir,'rooms.sqlite'));db.exec(`PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS rooms(code TEXT PRIMARY KEY,title TEXT,secret TEXT);
CREATE TABLE IF NOT EXISTS members(id TEXT PRIMARY KEY,room TEXT,name TEXT,secret TEXT);
CREATE INDEX IF NOT EXISTS members_name ON members(room,name);
CREATE TABLE IF NOT EXISTS docs(id TEXT,kind TEXT,data TEXT,rev INTEGER,PRIMARY KEY(id,kind));`);
db.exec(`CREATE TABLE IF NOT EXISTS shares(id TEXT PRIMARY KEY,enabled INTEGER);CREATE TABLE IF NOT EXISTS peerfeedback(author TEXT,target TEXT,quote TEXT,text TEXT);CREATE TABLE IF NOT EXISTS quizzes(id TEXT PRIMARY KEY,room TEXT,prompt TEXT);CREATE TABLE IF NOT EXISTS answers(quiz TEXT,student TEXT,text TEXT,mask TEXT,PRIMARY KEY(quiz,student));`);
const sessions=new Map(), attempts=new Map(), files={'/':'index.html','/editor':'editor.html'};
function fail(status,message){throw Object.assign(Error(message),{status})}
function hash(value,salt=crypto.randomBytes(16).toString('hex')){return salt+':'+crypto.scryptSync(value,salt,32).toString('hex')}
function matches(value,stored){return crypto.timingSafeEqual(Buffer.from(hash(value,stored.split(':')[0])),Buffer.from(stored))}
function field(value,max=80){if(typeof value!=='string'||!value.trim()||value.length>max)fail(400,'입력값을 확인하세요.');return value.trim()}
function state(s){const members=s.admin?db.prepare('SELECT id,name FROM members WHERE room=? ORDER BY name,id').all(s.room):db.prepare('SELECT id,name FROM members WHERE id=?').all(s.id);
const docs=db.prepare('SELECT d.* FROM docs d JOIN members m ON m.id=d.id WHERE m.room=? AND (? OR m.id=?)').all(s.room,+s.admin,s.id||'');return {...s,expires:undefined,members,docs:docs.map(d=>({...d,data:JSON.parse(d.data)}))}}
const server=http.createServer(async(req,res)=>{function send(n,obj){res.writeHead(n,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(obj))}
try{const url=req.url.split('?')[0];if(req.method==='GET'&&Object.hasOwn(files,url)){res.setHeader('Content-Type','text/html; charset=utf-8');res.end(fs.readFileSync(path.join(__dirname,files[url])));return}
const token=(req.headers.authorization||'').replace(/^Bearer /,''),session=sessions.get(token);
if(req.method==='GET'&&url==='/api/state'){if(!session||session.expires<Date.now())fail(401,'다시 입장하세요.');return send(200,state(session))}
if(req.method!=='POST'||req.headers['content-type']!=='application/json')fail(404,'요청을 확인하세요.');
let chunks=[],size=0;for await(const buf of req){size+=buf.length;if(size>8e6)fail(413,'원고 저장 한도를 넘었습니다.');chunks.push(buf)}const x=JSON.parse(Buffer.concat(chunks).toString());
if(url==='/api/login'){const ip=req.socket.remoteAddress,t=Date.now();let a=attempts.get(ip)||{count:0,until:0};if(a.until<t)a={count:0,until:t+60000};if(++a.count>180)fail(429,'잠시 후 다시 시도하세요.');attempts.set(ip,a);
const action=x.action;let room,id='',admin=false,title;const pass=field(x.pass,160);
if(action==='create'){title=field(x.title).normalize('NFC');if(pass.length<4)fail(400,'관리자 비밀번호를 4자 이상 입력하세요.');room=title;if(db.prepare('SELECT 1 FROM rooms WHERE title=? COLLATE NOCASE OR code=? COLLATE NOCASE').get(room,room))fail(409,'이미 사용하는 강의실 이름입니다. 분반이나 학기를 덧붙여 주세요.');db.prepare('INSERT INTO rooms VALUES(?,?,?)').run(room,title,hash(pass));admin=true}
else{const entry=field(x.room).normalize('NFC');let r=db.prepare('SELECT * FROM rooms WHERE code=? COLLATE NOCASE').get(entry);if(!r){const rows=db.prepare('SELECT * FROM rooms WHERE title=? COLLATE NOCASE').all(entry);if(rows.length>1)fail(409,'같은 이름의 기존 강의실이 여러 개입니다. 기존 방번호로 접속하세요.');r=rows[0]}if(!r)fail(404,'방번호를 확인하세요.');room=r.code;title=r.title;if(action==='admin'){if(!matches(pass,r.secret))fail(403,'관리자 비밀번호를 확인하세요.');admin=true}else if(action==='student'){const name=field(x.name);let member=db.prepare('SELECT * FROM members WHERE room=? AND name=?').get(room,name);if(member&&!matches(pass,member.secret))fail(403,'이름과 교번을 확인하세요.');id=member?.id||crypto.randomUUID().replaceAll('-','');if(!member)db.prepare('INSERT INTO members VALUES(?,?,?,?)').run(id,room,name,hash(pass))}else fail(400,'입장 방법을 확인하세요.')}
const key=crypto.randomBytes(32).toString('hex');sessions.set(key,{id,room,title,admin,expires:t+12*3600000});return send(200,{token:key})}
if(!session||session.expires<Date.now())fail(401,'다시 입장하세요.');
if(url==='/api/logout'){sessions.delete(token);return send(200,{})}
const room=session.room,uid=session.id;
if(url==='/api/activities'){const peers=db.prepare('SELECT m.id,m.name FROM members m JOIN shares s ON s.id=m.id WHERE m.room=? AND s.enabled=1 AND m.id<>?').all(room,uid);
const comments=db.prepare('SELECT f.quote,f.text,m.name FROM peerfeedback f JOIN members m ON m.id=f.author WHERE f.target=? ORDER BY f.rowid').all(uid);
const quizzes=db.prepare('SELECT id,prompt FROM quizzes WHERE room=? ORDER BY rowid').all(room);
const answers=session.admin?db.prepare('SELECT a.*,m.name FROM answers a JOIN quizzes q ON a.quiz=q.id JOIN members m ON a.student=m.id WHERE q.room=?').all(room):db.prepare('SELECT * FROM answers WHERE student=?').all(uid);
return send(200,{shared:!!db.prepare('SELECT enabled FROM shares WHERE id=?').get(uid)?.enabled,peers,comments,quizzes,answers})}
if(url==='/api/share'&&!session.admin){db.prepare('INSERT OR REPLACE INTO shares VALUES(?,?)').run(uid,+!!x.enabled);return send(200,{})}
if(url==='/api/peer'||url==='/api/peerfeedback'){const target=db.prepare('SELECT m.name FROM members m JOIN shares s ON s.id=m.id WHERE m.room=? AND m.id=? AND s.enabled=1 AND m.id<>?').get(room,x.target,uid);if(!target||session.admin)fail(403,'공유된 동료 원고를 선택하세요.');
if(url==='/api/peer'){let text='';for(const e of JSON.parse(db.prepare("SELECT data FROM docs WHERE id=? AND kind='edits'").get(x.target)?.data||'[]'))text=text.slice(0,e.at)+e.add+text.slice(e.at+e.del);return send(200,{text,name:target.name})}
db.prepare('INSERT INTO peerfeedback VALUES(?,?,?,?)').run(uid,x.target,String(x.quote||'').slice(0,500),field(x.text,3000));return send(200,{})}
if(url==='/api/quiz'&&session.admin){db.prepare('INSERT INTO quizzes VALUES(?,?,?)').run(crypto.randomUUID(),room,field(x.prompt,4000));return send(200,{})}
if(url==='/api/answer'&&!session.admin){if(!db.prepare('SELECT id FROM quizzes WHERE id=? AND room=?').get(x.quiz,room))fail(403,'이 강의실의 문제가 아닙니다.');if(typeof x.text!=='string'||x.text.length>20000||typeof x.mask!=='string'||x.mask.length!==x.text.length||/[^01]/.test(x.mask))fail(400,'답안을 확인하세요.');db.prepare('INSERT OR REPLACE INTO answers VALUES(?,?,?,?)').run(x.quiz,uid,x.text,x.mask);return send(200,{})}
if(url!=='/api/write')fail(404,'없는 요청입니다.');const m=db.prepare('SELECT room FROM members WHERE id=?').get(x.id);
if(!m||m.room!==session.room||(session.admin?!['comments','correction'].includes(x.kind):x.id!==session.id||!['edits','layout'].includes(x.kind)))fail(403,'저장 권한이 없습니다.');
if(!Array.isArray(x.data))fail(400,'잘못된 원고입니다.');let rev=db.prepare('SELECT rev FROM docs WHERE id=? AND kind=?').get(x.id,x.kind)?.rev||0;if(rev!==x.rev)fail(409,'다른 창에서 먼저 수정했습니다. 이 창의 글을 복사한 뒤 다시 입장하세요.');db.prepare('INSERT OR REPLACE INTO docs VALUES(?,?,?,?)').run(x.id,x.kind,JSON.stringify(x.data),++rev);send(200,{rev})
}catch(e){send(e.status||400,{error:e.status?e.message:'요청을 처리할 수 없습니다.'})}});
server.listen(Number(process.env.PORT||3817),process.env.HOST||'127.0.0.1',()=>console.log('문장실 http://'+server.address().address+':'+server.address().port));
