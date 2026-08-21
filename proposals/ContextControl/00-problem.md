# What a run carries, and what carrying it costs

Everything below was read out of the tree at `b69665a` — this branch's head when
the reading was taken — or measured from this install's own transcripts on
2026-08-21. Commands and their output are quoted rather than described; a figure
with no command beside it is not in this file. The window in most of them is the
rolling seven days, which is what `weekStart(now, null)` returns when no anchor
is set (`src/lib/windows.ts:276`–`277`) and `settings.weeklyAnchor` defaults to
`null` (`src/lib/settings.ts:606`). That this install has not overridden the
anchor is **assumed** — the settings row is in a database this run cannot open,
for the reason the next section gives.

**Re-running any command here will not reproduce its output exactly, and the
reason is the subject of the file.** The window slides, and the corpus grows
while it is being read — the run that took these measurements is itself writing
a transcript into `~/.claude/projects`, so the window's turn count moved by
about a hundred over the hour these commands took. Every output below is what
its command printed at the moment it ran, and the drift between them is tens of
turns and single dollars on totals in the thousands. Where two commands disagree
in the third significant figure, that is why.

## Where the numbers come from, and where they cannot come from

The live database is **not readable from here**, deliberately: `DATA_DIR` is
`/data` (`docker-compose.yml:188`), a named volume, and `docker-compose.yml:35`–`36`
says why an agent cannot open it. `/workspace/UsageFoundry/.data/usagefoundry.db`
is an `npm run dev` artifact — `DATA_DIR` defaults to `process.cwd()/.data`
(`src/lib/config.ts:281`) — and holds no `runs` row. So **no figure below comes
from `runs.spent_usd`, `run_reviews` or `otlp_requests`.** Every one comes from
the transcripts, which is the source `buildSnapshot()` itself reads
(`src/lib/transcripts.ts:406` → `src/lib/windows.ts:669`), through this app's
own `scanUsage()` and `pricing.ts` rather than through arithmetic written for
this document — the same route `proposals/ModelRouter/00-problem.md` took, and
for the same reason.

Where a figure needs message *content* rather than a usage block —
`scanUsage()` reads only the latter (`src/lib/transcripts.ts:226`, "if
(rec.type !== "assistant") return null") — the transcript files are walked
directly and the script is quoted whole.

The compile is one command:

    $ node_modules/.bin/tsc -p tsconfig.test.json --outDir /tmp/ctxctl-721638d11c0b-1

One filter recurs and is worth stating once. `scanUsage()` reads
`~/.claude/projects`, which is one bind mount shared with the host (`CLAUDE.md`),
so it sees the operator's own laptop sessions beside every run this container
started. A session whose `cwd` begins `/workspace` ran inside the container; one
beginning `/Users/` did not, and no argv this app builds ever reached it. Where
a measurement is about what *this app* pays, it is filtered to `/workspace`.

## The number that started this still holds

`proposals/ModelRouter/00-problem.md:329`–`334` reported 62.1% cache reads and
20.9% one-hour cache writes across the whole week — 83% of the bill carried
context rather than generated answers. Re-run today over the same functions and
a window that has since slid by a day:

    $ node -e '
      const {scanUsage}=require("/tmp/ctxctl-721638d11c0b-1/lib/transcripts");
      const {resolvePrice,addTokens,ZERO_TOKENS}=require("/tmp/ctxctl-721638d11c0b-1/lib/pricing");
      scanUsage().then(s=>{
        const w=Date.now()-7*24*3600*1000, e=s.entries.filter(x=>x.ts>=w);
        const t=e.reduce((a,x)=>addTokens(a,x.tokens),ZERO_TOKENS);
        const p=resolvePrice("claude-opus-5");
        const parts={input:t.input*p.input, output:t.output*p.output,
          cacheRead:t.cacheRead*p.input*0.1, cacheWrite5m:t.cacheWrite5m*p.input*1.25,
          cacheWrite1h:t.cacheWrite1h*p.input*2.0};
        const tot=Object.values(parts).reduce((a,b)=>a+b,0)/1e6;
        console.log("turns",e.length,"actual $"+e.reduce((a,x)=>a+x.costUSD,0).toFixed(2));
        for(const [k,v] of Object.entries(parts))
          console.log(k.padEnd(13),"$"+(v/1e6).toFixed(2),(100*v/1e6/tot).toFixed(1)+"%");
        console.log("all at opus-5 rates $"+tot.toFixed(2));
      });'

    turns 26165 actual $3588.18
    input         $1.33 0.0%
    output        $440.59 12.1%
    cacheRead     $2244.91 61.8%
    cacheWrite5m  $202.39 5.6%
    cacheWrite1h  $743.43 20.5%
    all at opus-5 rates $3632.65

61.8% and 20.5%, so **82.3% of the week is carried context**. The claim holds.
Everything after this decomposes that number; nothing after this re-asserts it.

Narrowed to the traffic this app actually starts — container `cwd`, main thread —
and with one further figure that several later sections lean on:

    $ node -e '
      const {scanUsage}=require("/tmp/ctxctl-721638d11c0b-1/lib/transcripts");
      const {addTokens,ZERO_TOKENS,resolvePrice}=require("/tmp/ctxctl-721638d11c0b-1/lib/pricing");
      scanUsage().then(s=>{
        const w=Date.now()-7*24*3600*1000;
        const main=s.entries.filter(x=>x.ts>=w&&x.project.startsWith("/workspace")
          &&!x.agent&&!x.isSidechain);
        const P=resolvePrice("claude-opus-5");
        const t=main.reduce((a,x)=>addTokens(a,x.tokens),ZERO_TOKENS);
        const parts={input:t.input*P.input,output:t.output*P.output,
          cacheRead:t.cacheRead*P.input*0.1,cacheWrite5m:t.cacheWrite5m*P.input*1.25,
          cacheWrite1h:t.cacheWrite1h*P.input*2.0};
        const tot=Object.values(parts).reduce((a,b)=>a+b,0)/1e6;
        console.log("container main-thread, rolling week:",main.length,"turns, actual $"+
          main.reduce((a,x)=>a+x.costUSD,0).toFixed(2));
        for(const [k,v] of Object.entries(parts))
          console.log("  "+k.padEnd(13),"$"+(v/1e6).toFixed(2),(100*v/1e6/tot).toFixed(1)+"%");
        console.log("  total $"+tot.toFixed(2));
        const by=new Map();
        for(const x of s.entries){ if(!x.project.includes("/.uf-worktrees/")) continue;
          const v=by.get(x.sessionId)??by.set(x.sessionId,{n:0,cr:0,syn:true}).get(x.sessionId);
          v.n++; v.cr+=x.tokens.cacheRead; if(x.model!=="<synthetic>") v.syn=false; }
        const long=[...by.values()].filter(v=>!v.syn&&v.n>=50).sort((a,b)=>a.cr-b.cr);
        console.log("\nlong sessions (>=50 turns):",long.length,
          "median carried context over the session",
          long[Math.floor(long.length/2)].cr.toLocaleString("en-US"),"cache-read tokens"); });'

    container main-thread, rolling week: 16605 turns, actual $2707.57
      input         $0.68 0.0%
      output        $387.76 14.3%
      cacheRead     $1642.86 60.7%
      cacheWrite5m  $0.00 0.0%
      cacheWrite1h  $676.40 25.0%
      total $2707.69

    long sessions (>=50 turns): 182 median carried context over the session 17,079,927 cache-read tokens

Note the zero in the five-minute row. It is not a rounding artefact, and the
section on the cache-write line is about it.

## Cost per turn grows with turn index, and roughly linearly

One `.jsonl` under a `.uf-worktrees/` project directory is one resumed
conversation, and because `buildArgs` passes `--resume` on every cycle after the
first (`src/lib/orchestrator.ts:4874`) that is one run's whole segment. Taking
the 80 such sessions with a hundred or more main-thread turns — delegated turns
excluded, because a sub-agent's context is its own — and bucketing each turn by
its position within its own session:

    $ node -e '
      const {scanUsage}=require("/tmp/ctxctl-721638d11c0b-1/lib/transcripts");
      scanUsage().then(s=>{
        const by=new Map();
        for(const x of s.entries){
          if(!x.project.includes("/.uf-worktrees/")) continue;
          if(x.agent||x.isSidechain||x.model==="<synthetic>") continue;
          (by.get(x.sessionId)??by.set(x.sessionId,[]).get(x.sessionId)).push(x); }
        const long=[...by.values()].filter(a=>a.length>=100);
        for(const a of long) a.sort((p,q)=>p.ts-q.ts);
        console.log("sessions with >=100 main-thread turns:",long.length,
          "| turns",long.reduce((n,a)=>n+a.length,0),
          "| $"+long.reduce((c,a)=>c+a.reduce((t,x)=>t+x.costUSD,0),0).toFixed(2));
        const D=10, sum=Array.from({length:D},()=>({n:0,cr:0,cost:0,out:0,cw1:0}));
        for(const a of long) a.forEach((x,i)=>{
          const b=sum[Math.min(D-1,Math.floor(D*i/a.length))];
          b.n++; b.cr+=x.tokens.cacheRead; b.cost+=x.costUSD;
          b.out+=x.tokens.output; b.cw1+=x.tokens.cacheWrite1h; });
        console.log("\ndecile  turns   mean cacheRead   mean $/turn   mean out tok   mean 1h-write");
        sum.forEach((b,i)=>console.log(String(i+1).padStart(4),String(b.n).padStart(7),
          (b.cr/b.n).toFixed(0).padStart(15),("$"+(b.cost/b.n).toFixed(4)).padStart(13),
          (b.out/b.n).toFixed(0).padStart(14),(b.cw1/b.n).toFixed(0).padStart(15)));
        const bands=[[0,9],[10,19],[20,39],[40,79],[80,159],[160,319],[320,1e9]];
        const bs=bands.map(()=>({n:0,cr:0,cost:0}));
        for(const a of long) a.forEach((x,i)=>{
          const k=bands.findIndex(([lo,hi])=>i>=lo&&i<=hi);
          bs[k].n++; bs[k].cr+=x.tokens.cacheRead; bs[k].cost+=x.costUSD; });
        console.log("\nturn index   turns   mean cacheRead   mean $/turn");
        bands.forEach(([lo,hi],k)=>{ const b=bs[k]; if(!b.n) return;
          console.log((lo+"-"+(hi>1e8?"":hi)).padStart(10),String(b.n).padStart(7),
            (b.cr/b.n).toFixed(0).padStart(15),("$"+(b.cost/b.n).toFixed(4)).padStart(13)); });
        let n=0,sx=0,sy=0,sxx=0,sxy=0,syy=0;
        for(const a of long) a.forEach((x,i)=>{ n++; sx+=i; sy+=x.tokens.cacheRead;
          sxx+=i*i; sxy+=i*x.tokens.cacheRead; syy+=x.tokens.cacheRead**2; });
        const slope=(n*sxy-sx*sy)/(n*sxx-sx*sx);
        const r=(n*sxy-sx*sy)/Math.sqrt((n*sxx-sx*sx)*(n*syy-sy*sy));
        console.log("\npooled OLS cacheRead ~ turnIndex: slope",slope.toFixed(0),
          "tok/turn  intercept",((sy-slope*sx)/n).toFixed(0),
          "  r^2",(r*r).toFixed(3),"  n",n); });'

    sessions with >=100 main-thread turns: 80 | turns 11422 | $1938.35

    decile  turns   mean cacheRead   mean $/turn   mean out tok   mean 1h-write
       1    1176           99369       $0.1505            721            8266
       2    1136          162881       $0.1421           1332            2732
       3    1150          190660       $0.1358            943            1686
       4    1137          211629       $0.1393            761            1445
       5    1132          229059       $0.1484            677            1689
       6    1153          246110       $0.1650            708            2426
       7    1146          264305       $0.1612            616            1366
       8    1141          279288       $0.1827            634            2722
       9    1145          296211       $0.1944            615            3095
      10    1106          305469       $0.2814            618           11323

    turn index   turns   mean cacheRead   mean $/turn
           0-9     800           82398       $0.1598
         10-19     800          137018       $0.1407
         20-39    1600          175530       $0.1309
         40-79    3200          217207       $0.1431
        80-159    4215          277044       $0.1988
       160-319     807          352191       $0.2389

    pooled OLS cacheRead ~ turnIndex: slope 1304 tok/turn  intercept 128271   r^2 0.574   n 11422

**Yes, the growth is linear in turn count**, at about 1,304 cache-read tokens per
turn, with an r² of 0.574 pooled across sessions of very different shapes. The
intercept is the interesting half: a conversation opens already carrying about
128,000 tokens before its first tool call, which is the prefix the levers
section returns to.

Note what does *not* grow. Mean output tokens fall from 721 in the first decile
to 618 in the last. The turn is not doing more; it is standing on more.

The direct answer to "what does that make the last ten turns of a long cycle
cost relative to its first ten":

    $ node -e '
      const {scanUsage}=require("/tmp/ctxctl-721638d11c0b-1/lib/transcripts");
      scanUsage().then(s=>{
        const by=new Map();
        for(const x of s.entries){
          if(!x.project.includes("/.uf-worktrees/")) continue;
          if(x.agent||x.isSidechain||x.model==="<synthetic>") continue;
          (by.get(x.sessionId)??by.set(x.sessionId,[]).get(x.sessionId)).push(x); }
        const long=[...by.entries()].filter(([,a])=>a.length>=100)
          .map(([id,a])=>[id,a.sort((p,q)=>p.ts-q.ts)]);
        const mean=a=>a.reduce((t,x)=>t+x,0)/a.length;
        const first=[],last=[],ratio=[];
        for(const [,a] of long){
          const f=a.slice(0,10).reduce((t,x)=>t+x.costUSD,0);
          const l=a.slice(-10).reduce((t,x)=>t+x.costUSD,0);
          first.push(f); last.push(l); if(f>0) ratio.push(l/f); }
        ratio.sort((p,q)=>p-q);
        console.log("sessions",long.length);
        console.log("first 10 turns: mean $"+mean(first).toFixed(2),
          " last 10 turns: mean $"+mean(last).toFixed(2),
          " ratio of means",(mean(last)/mean(first)).toFixed(2)+"x");
        console.log("per-session last10/first10 ratio: median",
          ratio[Math.floor(ratio.length/2)].toFixed(2)+"x",
          " p25",ratio[Math.floor(.25*ratio.length)].toFixed(2)+"x",
          " p75",ratio[Math.floor(.75*ratio.length)].toFixed(2)+"x");
        console.log("\nlongest sessions:  turns  total$   first10$  last10$  ratio  file");
        for(const [id,a] of [...long].sort((a,b)=>b[1].length-a[1].length).slice(0,8)){
          const f=a.slice(0,10).reduce((t,x)=>t+x.costUSD,0);
          const l=a.slice(-10).reduce((t,x)=>t+x.costUSD,0);
          console.log(String(a.length).padStart(20),
            ("$"+a.reduce((t,x)=>t+x.costUSD,0).toFixed(2)).padStart(8),
            ("$"+f.toFixed(2)).padStart(9),("$"+l.toFixed(2)).padStart(8),
            (l/f).toFixed(2)+"x", id); }
        const halves=long.map(([,a])=>{ const h=Math.floor(a.length/2);
          const A=a.slice(0,h).reduce((t,x)=>t+x.costUSD,0);
          const B=a.slice(h).reduce((t,x)=>t+x.costUSD,0); return B/(A+B); });
        halves.sort((p,q)=>p-q);
        console.log("\nshare of a session'"'"'s cost in its second half: median",
          (100*halves[Math.floor(halves.length/2)]).toFixed(1)+"%"); });'

    sessions 80
    first 10 turns: mean $1.60  last 10 turns: mean $3.01  ratio of means 1.88x
    per-session last10/first10 ratio: median 1.90x  p25 1.21x  p75 2.70x

    longest sessions:  turns  total$   first10$  last10$  ratio  file
                     258   $38.49     $1.26    $1.58 1.25x d57c1426-55a6-4afe-9d29-158ba0ce6b9c
                     256   $46.20     $1.61    $2.25 1.40x 1e66e1ef-9426-4f27-953a-95eb420ce5b7
                     241   $42.58     $0.93    $2.24 2.42x 6e2d0c57-214f-4092-90c0-87040cd304e6
                     232   $41.64     $1.84    $2.19 1.19x c9fd9e48-7aeb-449b-b450-5eb2412df9ab
                     220   $46.22     $2.13    $2.60 1.22x 06510dfb-60fd-48fe-9bf9-56ba6e5478fa
                     220   $40.78     $1.90    $2.30 1.21x f2de6d64-52c2-4960-b985-83f4b160f6fb
                     215   $43.75     $1.86    $5.77 3.10x 107d782c-3444-4039-b686-83f71248dc73
                     213   $37.14     $1.83    $5.30 2.89x 8a3790dd-6d93-469b-aed9-4086aecb9fb2

    share of a session's cost in its second half: median 57.8%

**The last ten turns of a long run cost 1.9 times its first ten**, median, for
work that emits 14% fewer output tokens. The second half of a session carries
57.8% of its money.

That is the honest ceiling on "just make the conversation shorter". It is a
1.9× at the tail of a 100-plus-turn session, not an order of magnitude, and the
median session's whole second half is 58% rather than 90%.

## What is being carried

The transcripts hold message content, not only usage blocks. Walking the forty
largest container transcripts and classifying every main-thread content block:

    $ node -e '
      const fs=require("fs"), path=require("path");
      const ROOT="/home/node/.claude/projects";
      const files=[];
      for(const d of fs.readdirSync(ROOT)){ if(!d.startsWith("-workspace")) continue;
        const dir=path.join(ROOT,d);
        for(const f of fs.readdirSync(dir)) if(f.endsWith(".jsonl"))
          files.push({p:path.join(dir,f), b:fs.statSync(path.join(dir,f)).size}); }
      files.sort((a,b)=>b.b-a.b);
      const bytes={}, count={}, sizes=[], add=(k,n)=>{bytes[k]=(bytes[k]||0)+n; count[k]=(count[k]||0)+1;};
      let attachBytes=0, attachN=0;
      const blockBytes=b=>{
        if(typeof b==="string") return Buffer.byteLength(b);
        if(b.type==="tool_result"){ const c=b.content;
          return Buffer.byteLength(typeof c==="string"?c:JSON.stringify(c??"")); }
        if(b.type==="text"||b.type==="thinking")
          return Buffer.byteLength(b.text??b.thinking??"");
        return Buffer.byteLength(JSON.stringify(b)); };
      for(const {p} of files.slice(0,40)){
        for(const line of fs.readFileSync(p,"utf8").split("\n")){
          if(!line) continue; let r; try{r=JSON.parse(line)}catch{continue}
          if(r.isSidechain===true) continue;
          if(r.type==="attachment"){ attachBytes+=Buffer.byteLength(JSON.stringify(r.attachment??{})); attachN++; continue; }
          if(r.type!=="assistant"&&r.type!=="user") continue;
          const m=r.message; if(!m) continue;
          const c=m.content, blocks=typeof c==="string"?[c]:Array.isArray(c)?c:[];
          for(const b of blocks){
            const n=blockBytes(b);
            const kind=typeof b==="string"?(r.type==="user"?"user text":"assistant text")
              : b.type==="tool_result"?"tool_result"
              : b.type==="text"?(r.type==="user"?"user text":"assistant text")
              : b.type==="thinking"?"thinking"
              : b.type==="tool_use"?"tool_use (the call)" : b.type;
            add(kind,n); if(kind==="tool_result") sizes.push(n); } } }
      const tot=Object.values(bytes).reduce((a,b)=>a+b,0);
      console.log("files 40 | main-thread content",(tot/1e6).toFixed(1),"MB");
      console.log("\nblock kind            blocks         bytes    share   mean bytes");
      for(const [k,v] of Object.entries(bytes).sort((a,b)=>b[1]-a[1]))
        console.log(k.padEnd(20),String(count[k]).padStart(8),String(v).padStart(14),
          (100*v/tot).toFixed(1).padStart(6)+"%",(v/count[k]).toFixed(0).padStart(12));
      console.log("attachment records",attachN,"holding",attachBytes,"bytes (not counted above)");
      const s=sizes.sort((a,b)=>a-b), q=f=>s[Math.floor(f*(s.length-1))];
      console.log("\ntool_result bytes: n",s.length,"p50",q(.5),"p75",q(.75),"p90",q(.9),
        "p99",q(.99),"max",q(1));
      const all=s.reduce((a,b)=>a+b,0);
      console.log("largest 1% of tool_results hold",
        (100*s.slice(-Math.ceil(s.length*0.01)).reduce((a,b)=>a+b,0)/all).toFixed(1),
        "% of tool_result bytes; largest 10% hold",
        (100*s.slice(-Math.ceil(s.length*0.10)).reduce((a,b)=>a+b,0)/all).toFixed(1)+"%");'

    files 40 | main-thread content 35.2 MB

    block kind            blocks         bytes    share   mean bytes
    tool_result              7221       22603952   64.2%         3130
    tool_use (the call)      7221        8121790   23.1%         1125
    user text                 100        4199856   11.9%        41999
    assistant text            700         287849    0.8%          411
    thinking                 3001              0    0.0%            0
    attachment records 2772 holding 3202037 bytes (not counted above)

    tool_result bytes: n 7221 p50 278 p75 2177 p90 6206 p99 41227 max 602196
    largest 1% of tool_results hold 31.8 % of tool_result bytes; largest 10% hold 72.2%

Four readings, in order of how much they matter.

**Tool results are 64.2% of the conversation and their distribution is savage.**
The median tool result is 278 bytes; the largest 1% carry 31.8% of all
tool-result bytes and the largest 10% carry 72.2%. So the bytes are in 722 of
these 7,221 blocks — about eighteen per conversation — and a mechanism that
treats tool results uniformly is doing 7,221 blocks' worth of work to reach
eighteen.

**The single largest contributor is `Read`.** Matching each result back to the
`tool_use` that produced it:

    $ node -e '
      const fs=require("fs"), path=require("path");
      const ROOT="/home/node/.claude/projects";
      const files=[];
      for(const d of fs.readdirSync(ROOT)){ if(!d.startsWith("-workspace")) continue;
        for(const f of fs.readdirSync(path.join(ROOT,d))) if(f.endsWith(".jsonl"))
          files.push({p:path.join(ROOT,d,f), b:fs.statSync(path.join(ROOT,d,f)).size}); }
      files.sort((a,b)=>b.b-a.b);
      const byTool={}, byToolN={}, dupes={}; let trTotal=0;
      for(const {p} of files.slice(0,40)){
        const name=new Map(), local=new Map();
        for(const line of fs.readFileSync(p,"utf8").split("\n")){
          if(!line) continue; let r; try{r=JSON.parse(line)}catch{continue}
          if(r.isSidechain===true) continue;
          const c=r.message&&r.message.content; if(!Array.isArray(c)) continue;
          for(const b of c){
            if(b.type==="tool_use") name.set(b.id,b.name);
            else if(b.type==="tool_result"){
              const txt=typeof b.content==="string"?b.content:JSON.stringify(b.content??"");
              const n=Buffer.byteLength(txt); trTotal+=n;
              const t=name.get(b.tool_use_id)??"(unmatched)";
              byTool[t]=(byTool[t]||0)+n; byToolN[t]=(byToolN[t]||0)+1;
              if(n>=2000){ const k=t+"|"+txt.length+"|"+txt.slice(0,200);
                if(local.has(k)) dupes[t]=(dupes[t]||0)+n; else local.set(k,n); } } } } }
      console.log("tool                    results         bytes    share   mean bytes");
      for(const [t,v] of Object.entries(byTool).sort((a,b)=>b[1]-a[1]).slice(0,7))
        console.log(t.padEnd(22),String(byToolN[t]).padStart(9),String(v).padStart(14),
          (100*v/trTotal).toFixed(1).padStart(6)+"%",(v/byToolN[t]).toFixed(0).padStart(12));
      const dt=Object.values(dupes).reduce((a,b)=>a+b,0);
      console.log("\nbytes in a >=2KB tool_result whose (tool, length, first 200 chars) had already");
      console.log("appeared verbatim earlier in the same conversation:",dt,
        "=",(100*dt/trTotal).toFixed(1)+"% of tool_result bytes");'

    tool                    results         bytes    share   mean bytes
    Read                        1260       16288686   72.1%        12928
    Bash                        3182        4799732   21.2%         1508
    WebSearch                    132         446200    2.0%         3380
    WebFetch                     145         427429    1.9%         2948
    Edit                        1934         353334    1.6%          183
    Agent                        103         204680    0.9%         1987
    Write                        318          57034    0.3%          179

    bytes in a >=2KB tool_result whose (tool, length, first 200 chars) had already
    appeared verbatim earlier in the same conversation: 64188 = 0.3% of tool_result bytes

1,260 `Read` results holding 16.3 MB — 72.1% of tool-result bytes, and therefore
**46% of everything in a main-thread conversation is file contents an agent chose
to read**. `Bash` is a distant second at 21.2% over two and a half times as
many calls. And it is not duplication: verbatim re-reads are 0.3%. Files are
opened once and carried for ever.

**How much of it was needed once and never again cannot be established from the
transcript, and what can be is a proxy.** Whether the model attended to a block
on a later turn is not recorded anywhere; the transcript records only what was
sent. The nearest testable question is whether the *path* a `Read` returned is
ever named again after the result comes back — in a later tool call's input or
in assistant text:

    $ node -e '
      const fs=require("fs"), path=require("path");
      const ROOT="/home/node/.claude/projects";
      const files=[];
      for(const d of fs.readdirSync(ROOT)){ if(!d.startsWith("-workspace")) continue;
        for(const f of fs.readdirSync(path.join(ROOT,d))) if(f.endsWith(".jsonl"))
          files.push({p:path.join(ROOT,d,f), b:fs.statSync(path.join(ROOT,d,f)).size}); }
      files.sort((a,b)=>b.b-a.b);
      let readBytes=0, unref=0, unrefN=0, n=0, edited=0, editedN=0;
      for(const {p} of files.slice(0,40)){
        const stream=[];
        for(const line of fs.readFileSync(p,"utf8").split("\n")){
          if(!line) continue; let r; try{r=JSON.parse(line)}catch{continue}
          if(r.isSidechain===true) continue;
          const c=r.message&&r.message.content; if(!Array.isArray(c)) continue;
          for(const b of c){
            if(b.type==="tool_use") stream.push({k:"use",name:b.name,inp:JSON.stringify(b.input??{}),id:b.id});
            else if(b.type==="tool_result"){
              const txt=typeof b.content==="string"?b.content:JSON.stringify(b.content??"");
              stream.push({k:"res",id:b.tool_use_id,bytes:Buffer.byteLength(txt)}); }
            else if(b.type==="text") stream.push({k:"text",inp:b.text??""}); } }
        for(let i=0;i<stream.length;i++){ const s=stream[i];
          if(s.k!=="use"||s.name!=="Read") continue;
          let fp=null; try{ fp=JSON.parse(s.inp).file_path }catch{}
          if(!fp) continue;
          const res=stream.find((x,j)=>j>i&&x.k==="res"&&x.id===s.id);
          if(!res) continue;
          const base=path.basename(fp);
          n++; readBytes+=res.bytes;
          let later=false, wasEdited=false;
          for(let j=i+1;j<stream.length;j++){ const t=stream[j];
            const hay=t.k==="use"||t.k==="text"?t.inp:""; if(!hay) continue;
            if(hay.includes(fp)||hay.includes(base)){ later=true;
              if(t.k==="use"&&(t.name==="Edit"||t.name==="Write"||t.name==="NotebookEdit")){
                try{ if(JSON.parse(t.inp).file_path===fp) wasEdited=true; }catch{} }
              if(wasEdited) break; } }
          if(wasEdited){ edited++; editedN+=res.bytes; }
          else if(!later){ unrefN++; unref+=res.bytes; } } }
      console.log("Read results with a file_path:",n,"holding",readBytes,"bytes");
      console.log("  never edited and the path never named again afterwards:",unrefN,
        "results,",unref,"bytes =",(100*unref/readBytes).toFixed(1)+"% of Read bytes");
      console.log("  the file was later edited or written:",edited,"results,",editedN,
        "bytes =",(100*editedN/readBytes).toFixed(1)+"%");
      console.log("  named again but not edited:",n-unrefN-edited,"results,",
        (readBytes-unref-editedN),"bytes =",(100*(readBytes-unref-editedN)/readBytes).toFixed(1)+"%");'

    Read results with a file_path: 1259 holding 16288291 bytes
      never edited and the path never named again afterwards: 219 results, 6427399 bytes = 39.5% of Read bytes
      the file was later edited or written: 637 results, 5081442 bytes = 31.2%
      named again but not edited: 403 results, 4779450 bytes = 29.3%

So **39.5% of `Read` bytes — 6.4 MB of the 35.2 MB measured, 18% of the whole
conversation — belong to files the run never mentions again**. That is a lower
bound on what a perfect oracle could have dropped and an upper bound on nothing:
a file whose name never recurs may still have been the thing that decided the
next edit. The proxy is named here so an option cannot quietly promise the
oracle.

**Thinking is invisible, and that is a hole in this measurement rather than a
zero.** Every thinking block in this corpus is written with its text stripped:

    $ cd /home/node/.claude/projects && node -e '
      const fs=require("fs"),path=require("path");
      let empty=0,full=0,fullBytes=0;
      for(const d of fs.readdirSync(".").filter(d=>d.startsWith("-workspace")))
        for(const f of fs.readdirSync(d)){ if(!f.endsWith(".jsonl")) continue;
          for(const l of fs.readFileSync(path.join(d,f),"utf8").split("\n")){ if(!l) continue;
            let r; try{r=JSON.parse(l)}catch{continue}
            const c=r.message&&r.message.content; if(!Array.isArray(c)) continue;
            for(const b of c) if(b.type==="thinking"){
              if((b.thinking||"").length===0) empty++;
              else { full++; fullBytes+=Buffer.byteLength(b.thinking); } } } }
      console.log("thinking blocks: empty",empty,"non-empty",full,"non-empty bytes",fullBytes);'

    thinking blocks: empty 13454 non-empty 0 non-empty bytes 0

13,454 thinking blocks, not one carrying its text. The signature survives and
the reasoning does not, so how much of a resumed conversation is retained
thinking **cannot be answered from the transcript**. It is not nothing: the
calibration below shows context growing faster than the visible bytes explain.

**`user text` is 100 blocks averaging 42 KB, and almost none of it is a person.**
It is the opening `-p` prompt — the task plus everything `nextPrompt` composes —
plus harness-injected blocks like sub-agent task notifications. This app writes
some of it and the levers section counts exactly how much.

### How many tokens a byte of that is

There is no tokenizer in this container (`ls node_modules | grep -i token`
returns nothing), so bytes are converted by fitting against the usage blocks the
same transcripts carry. Per file, regressing each turn's total context
(`input + cache_read + cache_creation`) on the cumulative content bytes before
it, and separately on the first differences between consecutive turns:

    $ node -e '
      const fs=require("fs"), path=require("path");
      const ROOT="/home/node/.claude/projects";
      const files=[];
      for(const d of fs.readdirSync(ROOT)){ if(!d.startsWith("-workspace")) continue;
        const dir=path.join(ROOT,d);
        for(const f of fs.readdirSync(dir)) if(f.endsWith(".jsonl"))
          files.push({p:path.join(dir,f), b:fs.statSync(path.join(dir,f)).size}); }
      files.sort((a,b)=>b.b-a.b);
      const blockBytes=b=>{
        if(typeof b==="string") return Buffer.byteLength(b);
        if(b.type==="tool_result"){ const c=b.content;
          return Buffer.byteLength(typeof c==="string"?c:JSON.stringify(c??"")); }
        if(b.type==="text") return Buffer.byteLength(b.text??"");
        if(b.type==="thinking") return Buffer.byteLength(b.thinking??"");
        return Buffer.byteLength(JSON.stringify(b)); };
      const slopes=[], intercepts=[], diffSlopes=[];
      for(const {p} of files.slice(0,60)){
        let cum=0; const seen=new Set(), pts=[];
        for(const line of fs.readFileSync(p,"utf8").split("\n")){
          if(!line) continue; let r; try{r=JSON.parse(line)}catch{continue}
          if(r.isSidechain===true) continue;
          if(r.type!=="assistant"&&r.type!=="user") continue;
          const m=r.message; if(!m) continue;
          if(r.type==="assistant"&&m.usage){
            const k=(m.id||"")+":"+(r.requestId||"");
            const t=(m.usage.input_tokens||0)+(m.usage.cache_read_input_tokens||0)
                   +(m.usage.cache_creation_input_tokens||0);
            if(!seen.has(k)&&t>0){ seen.add(k); pts.push([cum,t]); } }
          const c=m.content, blocks=typeof c==="string"?[c]:Array.isArray(c)?c:[];
          for(const b of blocks) cum+=blockBytes(b); }
        if(pts.length<40) continue;
        let n=0,sx=0,sy=0,sxx=0,sxy=0;
        for(const [x,y] of pts){ n++; sx+=x; sy+=y; sxx+=x*x; sxy+=x*y; }
        const sl=(n*sxy-sx*sy)/(n*sxx-sx*sx);
        slopes.push(sl); intercepts.push((sy-sl*sx)/n);
        let dn=0,dsx=0,dsy=0,dsxx=0,dsxy=0;
        for(let i=1;i<pts.length;i++){ const dx=pts[i][0]-pts[i-1][0], dy=pts[i][1]-pts[i-1][1];
          if(dx<=0||dy<=0) continue; dn++; dsx+=dx; dsy+=dy; dsxx+=dx*dx; dsxy+=dx*dy; }
        if(dn>=20) diffSlopes.push((dn*dsxy-dsx*dsy)/(dn*dsxx-dsx*dsx)); }
      const q=(a,f)=>{const s=[...a].sort((x,y)=>x-y); return s[Math.floor(f*(s.length-1))];};
      console.log("files with >=40 priced turns:",slopes.length);
      console.log("per-file OLS slope (tok/byte): median",q(slopes,.5).toFixed(4),
        "=> bytes/token median",(1/q(slopes,.5)).toFixed(2),
        " p25",(1/q(slopes,.75)).toFixed(2)," p75",(1/q(slopes,.25)).toFixed(2));
      console.log("per-file intercept (context tokens not in the transcript): median",
        q(intercepts,.5).toFixed(0)," p25",q(intercepts,.25).toFixed(0),
        " p75",q(intercepts,.75).toFixed(0));
      console.log("first-difference slope (tok/byte): n",diffSlopes.length,
        "median",q(diffSlopes,.5).toFixed(4),"=> bytes/token",(1/q(diffSlopes,.5)).toFixed(2),
        " p25",(1/q(diffSlopes,.75)).toFixed(2)," p75",(1/q(diffSlopes,.25)).toFixed(2));'

    files with >=40 priced turns: 60
    per-file OLS slope (tok/byte): median 0.4798 => bytes/token median 2.08  p25 1.85  p75 2.32
    per-file intercept (context tokens not in the transcript): median 31575  p25 19445  p75 66380
    first-difference slope (tok/byte): n 60 median 0.3739 => bytes/token 2.67  p25 2.54  p75 2.83

Two things fall out, and the second is the more useful.

The operational conversion is **0.374 tokens per visible byte** — every thousand
bytes of tool result or prompt in a conversation adds about 374 tokens to every
request after it. Note it is *not* a tokenizer ratio. English and code
run nearer four bytes per token, and this fit says 2.67, because the context
grows by more than the transcript shows: the stripped thinking text, the
per-turn reminders the CLI injects, the attachment deltas. Taking four
bytes per token as the true rate for visible text — **assumed**, not measured
here — that gap says roughly one further token enters context for every two
visible ones. An option that proposes to drop visible bytes is buying the
visible share of that, not all of it.

The per-file intercept — a median 31,575 tokens of context that never appears in
the transcript at all — is the fixed prefix: system prompt, tool schemas,
`CLAUDE.md`, the skill and agent listings, the environment block. It is paid on
every single turn of every run, and no part of it is legible from here.

## The one-hour cache-write line

$743.43 and 20.5% of the week. Two questions decide whether any of it is
addressable: what earns a one-hour write rather than a five-minute one, and how
often the same prefix is written twice.

**The first has a completely clean answer, and it is not about the traffic.**

    $ node -e '
      const {scanUsage}=require("/tmp/ctxctl-721638d11c0b-1/lib/transcripts");
      scanUsage().then(s=>{
        const w=Date.now()-7*24*3600*1000, e=s.entries.filter(x=>x.ts>=w), groups={};
        for(const x of e){
          const k=(x.project.startsWith("/workspace")?"container":"host")+" / "+
                  (x.agent||x.isSidechain?"delegated":"main thread");
          const g=groups[k]??(groups[k]={n:0,w5:0,w1:0});
          g.n++; g.w5+=x.tokens.cacheWrite5m; g.w1+=x.tokens.cacheWrite1h; }
        console.log("where / who                turns      5m-write tok     1h-write tok");
        for(const [k,g] of Object.entries(groups).sort((a,b)=>b[1].w5-a[1].w5))
          console.log(k.padEnd(26),String(g.n).padStart(6),
            String(g.w5).padStart(17),String(g.w1).padStart(17)); });'

    where / who                turns      5m-write tok     1h-write tok
    container / delegated        3116          17122528                 0
    host / delegated             4077          15260511                 0
    container / main thread     16579                 0          67585606
    host / main thread           2421                 0           6826117

    $ node -e '
      const {scanUsage}=require("/tmp/ctxctl-721638d11c0b-1/lib/transcripts");
      scanUsage().then(s=>{
        const w=Date.now()-7*24*3600*1000, e=s.entries.filter(x=>x.ts>=w);
        let m5=0,d1=0;
        for(const x of e){ const d=x.agent||x.isSidechain;
          if(!d&&x.tokens.cacheWrite5m>0) m5++;
          if(d&&x.tokens.cacheWrite1h>0) d1++; }
        console.log("main-thread turns with any 5m write:",m5,
          "| delegated turns with any 1h write:",d1,"| of",e.length,"turns in the window"); });'

    main-thread turns with any 5m write: 0 | delegated turns with any 1h write: 0 | of 26194 turns in the window

**Every main-thread turn on this install writes a one-hour cache and never a
five-minute one; every delegated turn writes a five-minute cache and never a
one-hour one. Zero exceptions in 26,194 turns.** The TTL is not a property of
the workload, the model, the project or the length of the conversation — it is a
property of which thread the turn is on, decided by the CLI. Nothing in this app
selects it and no flag `buildArgs` emits mentions it.

That reading is only trustworthy because `readTokens` keeps the two apart
honestly: an older record carrying only the aggregate is attributed to the
*five-minute* bucket (`src/lib/transcripts.ts:199`–`210`), so an unsplit record
would show up on the cheap side. The 5m column for main-thread traffic is
exactly zero, which means every one of those records declared
`ephemeral_1h_input_tokens` and the totals reconciled.

The consequence for arithmetic: main-thread context is written at **2.0× the
input rate** and read back at **0.1×** (`src/lib/pricing.ts:16`–`18`). One
written token costs what twenty read ones do.

**The second question is where the money is.** A turn that *extends* a warm
prefix reads a lot and writes a little. A turn that reads little and writes a
lot has had its prefix written again from near the start. Splitting container
main-thread turns on exactly that:

    $ node -e '
      const {scanUsage}=require("/tmp/ctxctl-721638d11c0b-1/lib/transcripts");
      const {resolvePrice}=require("/tmp/ctxctl-721638d11c0b-1/lib/pricing");
      const P=resolvePrice("claude-opus-5"), $=(tok,m)=>tok*P.input*m/1e6;
      scanUsage().then(s=>{
        const w=Date.now()-7*24*3600*1000;
        const e=s.entries.filter(x=>x.ts>=w&&!x.agent&&!x.isSidechain
          &&x.model!=="<synthetic>"&&x.project.startsWith("/workspace"));
        const by=new Map();
        for(const x of e) (by.get(x.sessionId)??by.set(x.sessionId,[]).get(x.sessionId)).push(x);
        for(const a of by.values()) a.sort((p,q)=>p.ts-q.ts);
        const names=["first turn of a session","gap < 5 min","5 min - 1 h","gap > 1 h"];
        const B=names.map(()=>({n:0,cr:0,w5:0,w1:0}));
        const rewarm={n:0,w1:0}, incr={n:0,w1:0}; let turns=0;
        for(const a of by.values()) a.forEach((x,i)=>{
          turns++;
          const gap=i===0?null:x.ts-a[i-1].ts;
          const b=B[gap===null?0:gap<5*60e3?1:gap<3600e3?2:3];
          b.n++; b.cr+=x.tokens.cacheRead; b.w5+=x.tokens.cacheWrite5m; b.w1+=x.tokens.cacheWrite1h;
          const t=(x.tokens.cacheWrite5m+x.tokens.cacheWrite1h)>x.tokens.cacheRead?rewarm:incr;
          t.n++; t.w1+=x.tokens.cacheWrite1h; });
        const tw1=B.reduce((t,b)=>t+b.w1,0), tw5=B.reduce((t,b)=>t+b.w5,0);
        console.log("container main-thread turns in the rolling week:",turns,"in",by.size,"sessions");
        console.log("\nsince previous turn   turns   mean cacheRead   mean 5m-write   mean 1h-write   1h $   share of 1h $");
        names.forEach((name,k)=>{ const b=B[k]; if(!b.n) return;
          console.log(name.padEnd(22),String(b.n).padStart(6),
            (b.cr/b.n).toFixed(0).padStart(15),(b.w5/b.n).toFixed(0).padStart(15),
            (b.w1/b.n).toFixed(0).padStart(15),("$"+$(b.w1,2).toFixed(2)).padStart(9),
            (100*b.w1/tw1).toFixed(1).padStart(9)+"%"); });
        console.log("\ntotals: 5m-write",tw5,"tok = $"+$(tw5,1.25).toFixed(2),
          " | 1h-write",tw1,"tok = $"+$(tw1,2).toFixed(2));
        console.log("\nturns whose cache WRITE exceeds its cache READ (a prefix written, not extended):");
        console.log("  n",rewarm.n,"("+(100*rewarm.n/turns).toFixed(1)+"% of turns) 1h-write",
          rewarm.w1,"tok = $"+$(rewarm.w1,2).toFixed(2),
          "=",(100*rewarm.w1/tw1).toFixed(1)+"% of the 1h line");
        console.log("  the other",incr.n,"turns: 1h-write",incr.w1,
          "tok = $"+$(incr.w1,2).toFixed(2)); });'

    container main-thread turns in the rolling week: 16533 in 235 sessions

    since previous turn   turns   mean cacheRead   mean 5m-write   mean 1h-write   1h $   share of 1h $
    first turn of a session    235           14293               0           46264   $108.72      16.1%
    gap < 5 min             16246          201389               0            3151   $511.97      75.8%
    5 min - 1 h                29          205089               0           13194     $3.83       0.6%
    gap > 1 h                  23           18830               0          223110    $51.32       7.6%

    totals: 5m-write 0 tok = $0.00  | 1h-write 67583108 tok = $675.83

    turns whose cache WRITE exceeds its cache READ (a prefix written, not extended):
      n 229 (1.4% of turns) 1h-write 30180077 tok = $301.80 = 44.7% of the 1h line
      the other 16304 turns: 1h-write 37403031 tok = $374.03

**1.4% of turns carry 44.7% of the one-hour cache-write line** — $301.80 of
$675.83 in container main-thread traffic. Breaking those 229 down by what
precedes them in the transcript:

    $ node -e '
      const fs=require("fs"), path=require("path");
      const ROOT="/home/node/.claude/projects", WEEK=Date.now()-7*24*3600*1000;
      const $=(t,m)=>t*5*m/1e6;   // claude-opus-5 input rate
      const cls={}; let sessions=0, handovers=0, handoverWrite=0, totalWrite=0, totalRead=0, turns=0;
      const perHandover=[];
      for(const d of fs.readdirSync(ROOT)){ if(!d.startsWith("-workspace")) continue;
        for(const f of fs.readdirSync(path.join(ROOT,d))){ if(!f.endsWith(".jsonl")) continue;
          const recs=fs.readFileSync(path.join(ROOT,d,f),"utf8").split("\n").filter(Boolean)
            .map(l=>{try{return JSON.parse(l)}catch{return null}}).filter(Boolean);
          const seen=new Set(); let lastUserText=null, any=false;
          for(const r of recs){
            if(r.isSidechain) continue;
            if(r.type==="user"){ const c=r.message&&r.message.content;
              const t=typeof c==="string"?c:(Array.isArray(c)?c.filter(b=>b.type==="text").map(b=>b.text).join(""):"");
              if(t) lastUserText=t; continue; }
            if(r.type!=="assistant") continue;
            const u=r.message&&r.message.usage; if(!u) continue;
            const k=(r.message.id||"")+":"+(r.requestId||""); if(seen.has(k)) continue; seen.add(k);
            const ts=Date.parse(r.timestamp||""); if(!(ts>=WEEK)) continue;
            any=true; turns++;
            const cr=u.cache_read_input_tokens||0, cw=u.cache_creation_input_tokens||0;
            totalWrite+=cw; totalRead+=cr;
            if(cw<=cr) continue;
            const t=lastUserText??"";
            const kind = seen.size===1 ? "opening turn of the session"
              : /^Continue working on the task\./.test(t) ? "continuation prompt (a work-cycle handover)"
              : /^You reported the task complete/.test(t) ? "DONE pushback (a work-cycle handover)"
              : t ? "some other user text" : "no user text before it";
            const g=cls[kind]??(cls[kind]={n:0,w:0}); g.n++; g.w+=cw;
            if(kind.includes("handover")){ handovers++; handoverWrite+=cw; perHandover.push(cw); } }
          if(any) sessions++; } }
      console.log("container sessions with a turn in the window:",sessions,"| main-thread turns",turns);
      console.log("cache write total",totalWrite,"tok = $"+$(totalWrite,2).toFixed(2),
        "| cache read total",totalRead,"tok = $"+$(totalRead,0.1).toFixed(2));
      console.log("\nwhat precedes a turn that writes more than it reads:   n      write $    share of the write line");
      for(const [k,g] of Object.entries(cls).sort((a,b)=>b[1].w-a[1].w))
        console.log("  "+k.padEnd(45),String(g.n).padStart(4),("$"+$(g.w,2).toFixed(2)).padStart(11),
          (100*g.w/totalWrite).toFixed(1).padStart(9)+"%");
      perHandover.sort((a,b)=>a-b);
      console.log("\nper handover: n",handovers,"median",perHandover[Math.floor(perHandover.length/2)],
        "tok = $"+$(perHandover[Math.floor(perHandover.length/2)],2).toFixed(2),
        "| max",perHandover[perHandover.length-1],
        "tok = $"+$(perHandover[perHandover.length-1],2).toFixed(2),
        "| total $"+$(handoverWrite,2).toFixed(2));'

    container sessions with a turn in the window: 237 | main-thread turns 16585
    cache write total 67596587 tok = $675.97 | cache read total 3282553155 tok = $1641.28

    what precedes a turn that writes more than it reads:   n      write $    share of the write line
      continuation prompt (a work-cycle handover)     79     $183.69      27.2%
      opening turn of the session                    133      $95.74      14.2%
      some other user text                            17      $22.37       3.3%

    per handover: n 79 median 231644 tok = $2.32 | max 437994 tok = $4.38 | total $183.69

**The single largest identified line inside the cache-write bill is the work-cycle
handover: 79 of them, $183.69, 27.2% of the write line, a median $2.32 each and
$4.38 at the worst.** A run that hands over between cycles pays, for the
privilege, a full re-write of everything it has said so far at twice the input
rate.

The clock is not the reason. Traced turn by turn through one session:

    $ cd /home/node/.claude/projects && node -e '
      const fs=require("fs"),path=require("path");
      const pre=process.argv[1]; let file=null;
      for(const d of fs.readdirSync(".")){ const dd=path.join(".",d);
        if(!fs.statSync(dd).isDirectory()) continue;
        for(const f of fs.readdirSync(dd)) if(f.startsWith(pre)&&f.endsWith(".jsonl")) file=path.join(dd,f); }
      const recs=fs.readFileSync(file,"utf8").split("\n").filter(Boolean)
        .map(l=>{try{return JSON.parse(l)}catch{return null}}).filter(Boolean);
      let idx=0; const seen=new Set();
      for(const r of recs){
        if(r.isSidechain) continue;
        if(r.type==="user"){ const c=r.message&&r.message.content;
          const t=typeof c==="string"?c:(Array.isArray(c)?c.filter(b=>b.type==="text").map(b=>b.text).join(""):"");
          if(t) console.log("  [user text @turn "+idx+"]",JSON.stringify(t.slice(0,110)));
          continue; }
        if(r.type!=="assistant") continue;
        const u=r.message&&r.message.usage; if(!u) continue;
        const k=(r.message.id||"")+":"+(r.requestId||""); if(seen.has(k)) continue; seen.add(k);
        const cr=u.cache_read_input_tokens||0, cw=u.cache_creation_input_tokens||0;
        if(cw>cr) console.log("*** turn",idx,"REWARM read",cr,"write",cw,r.timestamp);
        idx++; }
      console.log("total turns",idx,"file",file);' b4856fed

      [user text @turn 0] "You are working in a dedicated git worktree on your own branch, not in the user's checkout. Commit your work a"
    *** turn 0 REWARM read 19223 write 71036 2026-08-14T15:48:25.504Z
      [user text @turn 192] "Continue working on the task. If it is fully complete and verified, reply with exactly DONE on its own line an"
    *** turn 192 REWARM read 15903 write 300560 2026-08-14T16:09:58.502Z
    total turns 193 file -workspace--uf-worktrees-usagefoundry-3/b4856fed-9924-445d-8253-71aaa75199e5.jsonl

Turn 191 was twenty seconds earlier and the TTL is an hour. What arrived in
between was `settings.continuationPrompt` and a new `claude --resume` process,
and the 300,560-token conversation was written again: $3.01, on one cycle
boundary, for a conversation that had not changed.

**Not every handover pays it, and the ones that do not are what rule out the
easy explanation.**

    $ node -e '
      const fs=require("fs"), path=require("path");
      const ROOT="/home/node/.claude/projects", WEEK=Date.now()-7*24*3600*1000;
      const hit=[], miss=[];
      for(const d of fs.readdirSync(ROOT)){ if(!d.startsWith("-workspace")) continue;
        for(const f of fs.readdirSync(path.join(ROOT,d))){ if(!f.endsWith(".jsonl")) continue;
          const recs=fs.readFileSync(path.join(ROOT,d,f),"utf8").split("\n").filter(Boolean)
            .map(l=>{try{return JSON.parse(l)}catch{return null}}).filter(Boolean);
          const seen=new Set(); let pending=null, prevTs=null, prevVer=null;
          for(const r of recs){
            if(r.isSidechain) continue;
            if(r.type==="user"){ const c=r.message&&r.message.content;
              const t=typeof c==="string"?c:(Array.isArray(c)?c.filter(b=>b.type==="text").map(b=>b.text).join(""):"");
              if(t) pending=/^Continue working on the task\.|^You reported the task complete/.test(t)?"cont":"other";
              continue; }
            if(r.type!=="assistant") continue;
            const u=r.message&&r.message.usage; if(!u) continue;
            const k=(r.message.id||"")+":"+(r.requestId||""); if(seen.has(k)) continue; seen.add(k);
            const ts=Date.parse(r.timestamp||"");
            const cr=u.cache_read_input_tokens||0, cw=u.cache_creation_input_tokens||0;
            if(ts>=WEEK&&pending==="cont"&&seen.size>1)
              (cw>cr?miss:hit).push({gap:prevTs?ts-prevTs:null, ver:r.version, prevVer,
                cr, cw, sess:f.slice(0,8), effort:r.effort});
            prevTs=ts; prevVer=r.version; pending=null; } } }
      const g=a=>{const s=a.map(x=>x.gap??0).sort((p,q)=>p-q);
        return {n:a.length, min:(s[0]/1000).toFixed(0)+"s",
          med:(s[Math.floor(s.length/2)]/1000).toFixed(0)+"s",
          max:(s[s.length-1]/1000/60).toFixed(1)+"min",
          over1h:a.filter(x=>(x.gap??0)>3600e3).length}; };
      console.log("resumed-cycle openings that HIT the cache:",JSON.stringify(g(hit)));
      console.log("resumed-cycle openings that MISSED      :",JSON.stringify(g(miss)));
      const vc=a=>a.filter(x=>x.ver!==x.prevVer).length;
      console.log("CLI version changed across the handover: hit",vc(hit),"miss",vc(miss));
      const ec=a=>{const m={}; for(const x of a) m[x.effort??"-"]=(m[x.effort??"-"]||0)+1; return m;};
      console.log("effort on the resumed turn: hit",JSON.stringify(ec(hit)),
        "miss",JSON.stringify(ec(miss)));
      const ex=a=>a.slice(0,6).map(x=>x.sess+" gap "+((x.gap??0)/1000).toFixed(0)
        +"s read "+x.cr+" write "+x.cw).join("\n              ");
      console.log("\nHIT examples:",ex(hit));
      console.log("\nMISS examples:",ex(miss));'

    resumed-cycle openings that HIT the cache: {"n":29,"min":"2s","med":"22s","max":"10.2min","over1h":0}
    resumed-cycle openings that MISSED      : {"n":79,"min":"4s","med":"10s","max":"719.6min","over1h":2}
    CLI version changed across the handover: hit 0 miss 0
    effort on the resumed turn: hit {"xhigh":29} miss {"xhigh":79}

    HIT examples: 1ced38be gap 118s read 198263 write 10205
                  2065a0b8 gap 201s read 188046 write 70
                  40fe31ab gap 10s read 252490 write 241
                  40fe31ab gap 4s read 252490 write 298
                  40fe31ab gap 3s read 253226 write 60
                  25ae6759 gap 5s read 225646 write 1928

    MISS examples: 9d902b7b gap 35s read 15903 write 173123
                  508cd793 gap 12s read 16541 write 368623
                  92c4e4ea gap 10s read 16541 write 297186
                  9376b529 gap 9s read 15903 write 187034
                  a8cb1df4 gap 16s read 15903 write 267321
                  b58d0d3f gap 8s read 15903 write 192143

27% of handovers (29 of 108) read a median 240,048 tokens straight out of cache
across the same process boundary, at gaps as long as ten minutes. So **the CLI
can and does reuse a cached prefix across a `--resume`**; a miss is therefore
something in the prefix having *changed*, not the process boundary itself. Nor
is it the gap (the misses' median gap is 10 seconds against the hits' 22), the
CLI version (unchanged across every one of the 108), or the reasoning effort
(`xhigh` on all 108).

What is striking about the misses is how little they read. Four of the six
sampled read exactly 15,903 tokens and the other two exactly 16,541, across
different sessions, different worktrees and different days; 15,903 is also what
a fresh conversation's opening turn reads (the median in the next section). So
**a ~16,000-token prefix that every session on this install shares stays warm,
and everything after it is written again.** Naming what sits
immediately after that boundary — and therefore what changed — is not possible
from the transcript, which records no system block, no environment block and no
`<system-reminder>` (`grep -c system-reminder` over a container transcript
returns 0). That is the pin probe's question, and it is the most valuable single
thing this proposal does not yet know.

## A fresh conversation against a resumed one

Every "start fresh" option in the survey will be scored against this pair. A run
picked up after a pause opens a new conversation, and so does the second block
of a workflow chain.

    $ node -e '
      const fs=require("fs"), path=require("path");
      const ROOT="/home/node/.claude/projects", WEEK=Date.now()-7*24*3600*1000;
      const $=(t,m)=>t*5*m/1e6;
      const opens=[], allConts=[];
      for(const d of fs.readdirSync(ROOT)){ if(!d.startsWith("-workspace")) continue;
        for(const f of fs.readdirSync(path.join(ROOT,d))){ if(!f.endsWith(".jsonl")) continue;
          const recs=fs.readFileSync(path.join(ROOT,d,f),"utf8").split("\n").filter(Boolean)
            .map(l=>{try{return JSON.parse(l)}catch{return null}}).filter(Boolean);
          const seen=new Set(); let pending=null;
          for(const r of recs){
            if(r.isSidechain) continue;
            if(r.type==="user"){ const c=r.message&&r.message.content;
              const t=typeof c==="string"?c:(Array.isArray(c)?c.filter(b=>b.type==="text").map(b=>b.text).join(""):"");
              if(t) pending=/^Continue working on the task\.|^You reported the task complete/.test(t)?"cont":"other";
              continue; }
            if(r.type!=="assistant") continue;
            const u=r.message&&r.message.usage; if(!u) continue;
            const k=(r.message.id||"")+":"+(r.requestId||""); if(seen.has(k)) continue; seen.add(k);
            const ts=Date.parse(r.timestamp||""); if(!(ts>=WEEK)) { pending=null; continue; }
            const cr=u.cache_read_input_tokens||0, cw=u.cache_creation_input_tokens||0;
            const cost=$(cr,0.1)+$(cw,2)+((u.output_tokens||0)*25/1e6);
            if(seen.size===1) opens.push({cr,cw,cost});
            else if(pending==="cont") allConts.push({cr,cw,cost});
            pending=null; } } }
      const med=(a,f)=>{const s=a.map(f).sort((x,y)=>x-y); return s[Math.floor(s.length/2)];};
      const sum=(a,f)=>a.reduce((t,x)=>t+f(x),0);
      const row=(name,a)=>console.log(name.padEnd(46),String(a.length).padStart(5),
        med(a,x=>x.cr).toFixed(0).padStart(12), med(a,x=>x.cw).toFixed(0).padStart(12),
        ("$"+med(a,x=>x.cost).toFixed(3)).padStart(11), ("$"+sum(a,x=>x.cost).toFixed(2)).padStart(10));
      console.log("turn kind".padEnd(46),"    n","  median read"," median write"," median $","    total $");
      row("opening turn of a fresh conversation",opens);
      row("first turn after a continuation prompt (all)",allConts);
      row("  ... of those, the ones that re-wrote",allConts.filter(x=>x.cw>x.cr));
      row("  ... of those, the ones that did not",allConts.filter(x=>x.cw<=x.cr));'

    turn kind                                          n   median read  median write  median $     total $
    opening turn of a fresh conversation             237        15903        28971      $0.294    $112.02
    first turn after a continuation prompt (all)     108        16541       187865      $1.923    $190.85
      ... of those, the ones that re-wrote            79        15903       231644      $2.335    $185.49
      ... of those, the ones that did not             29       240048         1872      $0.165      $5.35

**A fresh conversation's opening turn costs a median $0.294. A resumed cycle's
costs $1.923 — 6.5 times as much — and $2.335 when it re-writes.** The 29 that
hit cost $0.165, half what a fresh opening costs.

Read carefully, because the naive reading of that table is the trap this whole
proposal is about. It does *not* say starting fresh is cheaper than resuming. It
says the two ends of the range are $0.165 and $2.335 and that today 73% of
handovers land on the expensive end. A fresh conversation is cheap at its
opening turn and then re-derives, from an empty context, everything the resumed
one already had — `priorWorkNotice` exists precisely because that agent "does
the first thing that task says, which is the work it is standing on top of"
(`src/lib/orchestrator.ts:4364`–`4373`), and `continuedWorkNotice` because a
fresh agent "either redoes the work or reverts it as leftovers. Both are billed
and both look like progress" (`src/lib/settings.ts:544`–`551`). Neither of those
costs is in the table.

The comparison the table *does* license is between the two resumption
behaviours, and there the gap is $2.17 a handover with no difference in what the
agent receives.

## Where the spread is

`proposals/ModelRouter/00-problem.md:293` measured fourteen times between the
cheapest and dearest long run at a constant model. It still does, and it is now
possible to say what explains it.

    $ node -e '
      const {scanUsage}=require("/tmp/ctxctl-721638d11c0b-1/lib/transcripts");
      scanUsage().then(s=>{
        const by=new Map();
        for(const x of s.entries){ if(!x.project.includes("/.uf-worktrees/")) continue;
          const v=by.get(x.sessionId)??by.set(x.sessionId,{c:0,n:0,syn:true,cr:0,out:0}).get(x.sessionId);
          v.c+=x.costUSD; v.n++; v.cr+=x.tokens.cacheRead; v.out+=x.tokens.output;
          if(x.model!=="<synthetic>") v.syn=false; }
        const long=[...by.values()].filter(v=>!v.syn&&v.n>=50).sort((a,b)=>a.c-b.c);
        const lo=long[0], hi=long[long.length-1];
        console.log("sessions >=50 turns:",long.length,
          "| cheapest $"+lo.c.toFixed(2),"("+lo.n+" turns)",
          "| dearest $"+hi.c.toFixed(2),"("+hi.n+" turns)",
          "| ratio",(hi.c/lo.c).toFixed(1)+"x");
        const R=(f,g)=>{ const n=long.length, xs=long.map(f), ys=long.map(g);
          const mx=xs.reduce((a,b)=>a+b,0)/n, my=ys.reduce((a,b)=>a+b,0)/n;
          let sxy=0,sxx=0,syy=0;
          for(let i=0;i<n;i++){ sxy+=(xs[i]-mx)*(ys[i]-my); sxx+=(xs[i]-mx)**2; syy+=(ys[i]-my)**2; }
          return sxy/Math.sqrt(sxx*syy); };
        const show=(label,r)=>console.log(label,"r =",r.toFixed(3),"  r^2 =",(r*r).toFixed(3));
        console.log();
        show("correlation of session cost with turn count:     ",R(v=>v.n,v=>v.c));
        show("same, both log-transformed:                      ",R(v=>Math.log(v.n),v=>Math.log(v.c)));
        show("with total cache-read tokens (context carried):  ",R(v=>v.cr,v=>v.c));
        show("with total output tokens (answers generated):    ",R(v=>v.out,v=>v.c));
        const band=long.filter(v=>v.n>=100&&v.n<=150).map(v=>v.c).sort((a,b)=>a-b);
        console.log("\nsessions of 100-150 turns: n",band.length,
          "min $"+band[0].toFixed(2),"median $"+band[Math.floor(band.length/2)].toFixed(2),
          "max $"+band[band.length-1].toFixed(2),
          "ratio",(band[band.length-1]/band[0]).toFixed(1)+"x");
        const cpt=long.map(v=>v.c/v.n).sort((a,b)=>a-b);
        console.log("cost per turn across those sessions: min $"+cpt[0].toFixed(3),
          "median $"+cpt[Math.floor(cpt.length/2)].toFixed(3),
          "max $"+cpt[cpt.length-1].toFixed(3),
          "ratio",(cpt[cpt.length-1]/cpt[0]).toFixed(1)+"x"); });'

    sessions >=50 turns: 181 | cheapest $4.75 (50 turns) | dearest $66.66 (339 turns) | ratio 14.0x

    correlation of session cost with turn count:      r = 0.640   r^2 = 0.410
    same, both log-transformed:                       r = 0.852   r^2 = 0.725
    with total cache-read tokens (context carried):   r = 0.967   r^2 = 0.935
    with total output tokens (answers generated):     r = 0.715   r^2 = 0.512

    sessions of 100-150 turns: n 49 min $8.91 median $18.86 max $30.08 ratio 3.4x
    cost per turn across those sessions: min $0.035 median $0.157 max $0.323 ratio 9.3x

**Carried context explains almost all of it: r² = 0.935 against total cache-read
tokens.** Turn count explains 41% linearly and 72.5% in logs; output tokens —
the work the run actually produced — explain 51%.

The residue is the part worth naming. At a fixed conversation length, 100 to 150
turns, the spread is still **3.4×**, and cost per turn across long sessions
varies **9.3×**, from $0.035 to $0.323. So conversation length accounts for
about three-quarters of the variance in log cost, and what is left is how heavy
each turn of it was — which is what the run put in it, and the one part of the
spread a context mechanism could touch without changing how much work gets done.

## The levers this app actually holds

Every line reference below was opened. The ModelRouter closing pass found
twenty-seven bare `:NNNN` references resolved against the wrong file, so nothing
here is carried over from a description.

### `buildArgs` — the whole argv a work cycle gets

`buildArgs` (`src/lib/orchestrator.ts:4756`) builds it, and it is called from
*inside* the cycle loop (`for (;;)` at `:6412`, the call at `:6701`), so the
whole argv is rebuilt and re-sent on every cycle including a resumed one. Six
entries bear on context:

- **`-p <prompt>`** (`:4842`) carries whatever `nextPrompt` composed. Counted
  below.
- **`--append-system-prompt SELF_HOSTING_NOTICE`** (`:4870`), unconditional, on
  every cycle. The string is at `:4739` and is 1,096 bytes. Its docblock says
  why it is on the system prompt rather than in the task — "the task is only
  sent on the first cycle of a session and this is true of every cycle"
  (`:4710`–`:4711`) — which is also what makes it prefix content rather than
  conversation content.
- **`--settings <json>`**, appended after `buildArgs` returns, by `sandboxArgs`
  (`:5158`, the flag at `:5162`) pushed at `:6760`. It is the one channel this
  app already uses to hand the CLI structured configuration on the argv without
  a file, and it is therefore the shape any new setting would take.
- **`--plugin-dir`** (`pluginDirArgs` at `src/lib/plugins.ts:123`, pushed at
  `:4873` from `enabledPluginDirs()` re-resolved per cycle at `:6690`). Its
  docblock records the property that matters to every option here:
  "`--plugin-dir` is **not** restored by `--resume`, so a version of this that
  only sent it on the opening cycle would leave every later cycle of the same run
  without the plugins — silently, since a session missing a hook behaves exactly
  like one that never had it" (`:4828`–`:4831`). A plugin directory becomes
  skills and hooks the CLI loads, so it is also a context lever and not only a
  capability one.
- **`--agents` / `--agent`** (`sessionAgentArgs` at `src/lib/agents.ts:433`,
  pushed at `:4851`). The payload carries the saved agent's `description` and
  `prompt` (`agentsFlagValue`, `src/lib/agents.ts:376`–`389`), and with `--agent`
  beside it that prompt is the **session's** own, not a role it may delegate to
  (`src/lib/agents.ts:88`–`96`). It is the one place an operator's own text
  reaches the system prompt rather than the conversation.
- **`--resume <sessionId>`** (`:4874`). The subject of the handover measurement
  above.

Two more are on the argv and their effect on context is **not established
here**: `--allowedTools` (`:4861`, `SEARCH_TOOLS` at `:4642`, plus
`ISOLATED_GIT_TOOLS` at `:4613` for an isolated run) and `--disallowedTools`
(`:4869`, `PROCESS_KILLERS` at `:4690`). Whether either changes the tool schema
the model is sent — and therefore the fixed prefix — or only what the CLI
permits at call time, is a question for the pin probe.

### `nextPrompt` — everything this app writes

`nextPrompt` (`src/lib/orchestrator.ts:4299`) is the one half of a run that is
text this app authors. Its parts: `isolationPreamble` and `SHARED_CHECKOUT_NOTICE`
(`:4577`), `continuedWorkNotice` (`:4401`), `priorWorkNotice` (`:4417`), the
task, the operator's follow-up, `COMPLETION_NOTICE` (`:4466`, gated on
`endsOnDone`) and `NEEDS_REVIEW_NOTICE` (`:4506`, deliberately not gated). On a
resumed cycle it returns `settings.continuationPrompt` or `donePushbackPrompt`
(`src/lib/settings.ts:114`, `:286`; defaults at `:516`, `:534`, wired in at
`:613`, `:624`) joined to the needs-review notice.

Calling it at the shipped defaults, with the task text standing in as `<TASK>`:

    $ NODE_PATH=./node_modules node -e '
      const O=require("/tmp/ctxctl-721638d11c0b-1/lib/orchestrator");
      const S=require("/tmp/ctxctl-721638d11c0b-1/lib/settings");
      const fs=require("fs");
      // the three the module does not export, read out of the compiled file it does
      const src=fs.readFileSync("/tmp/ctxctl-721638d11c0b-1/lib/orchestrator.js","utf8");
      const grab=name=>{ const i=src.indexOf("const "+name+" = ");
        return eval(src.slice(i+("const "+name+" = ").length, src.indexOf(";\n", i))); };
      const COMPLETION=grab("COMPLETION_NOTICE"), SELF=grab("SELF_HOSTING_NOTICE"),
            SHARED=grab("SHARED_CHECKOUT_NOTICE");
      const B=s=>Buffer.byteLength(s);
      const rows=[
        ["SELF_HOSTING_NOTICE (--append-system-prompt, every cycle)", SELF],
        ["COMPLETION_NOTICE (cycle 1, gated on endsOnDone)", COMPLETION],
        ["NEEDS_REVIEW_NOTICE (every cycle bar a follow-up)", O.NEEDS_REVIEW_NOTICE],
        ["DEFAULT_CONTINUATION_PROMPT (every resumed cycle)", S.DEFAULT_CONTINUATION_PROMPT],
        ["DEFAULT_DONE_PUSHBACK_PROMPT (instead, after a DONE)", S.DEFAULT_DONE_PUSHBACK_PROMPT],
        ["DEFAULT_ISOLATION_PREAMBLE (cycle 1, isolated run)", S.DEFAULT_ISOLATION_PREAMBLE],
        ["SHARED_CHECKOUT_NOTICE (cycle 1, isolated run)", SHARED],
        ["DEFAULT_CONTINUED_WORK_PROMPT (cycle 1, continued branch)", S.DEFAULT_CONTINUED_WORK_PROMPT]];
      console.log("string".padEnd(58),"chars","  bytes","  ~tokens @4B");
      for(const [n,s] of rows) console.log(n.padEnd(58),String(s.length).padStart(5),
        String(B(s)).padStart(7),String(Math.round(B(s)/4)).padStart(13));
      const base={task:"<TASK>",followUp:null,priorCycles:0,worktreeBranch:"uf/x",
        continuedFrom:null,continuedWork:S.DEFAULT_CONTINUED_WORK_PROMPT,
        continuation:S.DEFAULT_CONTINUATION_PROMPT,
        donePushback:S.DEFAULT_DONE_PUSHBACK_PROMPT,endsOnDone:true};
      const P=o=>O.nextPrompt({...base,...o});
      const cycle1=P({sessionId:null,justRetriggered:false,isolationPreamble:S.DEFAULT_ISOLATION_PREAMBLE});
      const plain1=P({sessionId:null,justRetriggered:false,isolationPreamble:null});
      const cycleN=P({sessionId:"sid",justRetriggered:false,priorCycles:1,
        isolationPreamble:S.DEFAULT_ISOLATION_PREAMBLE});
      const pushN=P({sessionId:"sid",justRetriggered:true,priorCycles:1,isolationPreamble:null});
      console.log("\nnextPrompt output at the shipped defaults:");
      for(const [n,p] of [["cycle 1, isolated",cycle1],["cycle 1, not isolated",plain1],
                          ["cycle 2+, continuation",cycleN],["cycle 2+, DONE pushback",pushN]])
        console.log("  "+n.padEnd(26),String(B(p)).padStart(6),"bytes  ~",
          String(Math.round(B(p)/4)).padStart(5),"tokens");
      const perCycle=B(cycleN)+B(SELF);
      console.log("\nper resumed cycle, app-authored text on the wire:",perCycle,
        "bytes ~",Math.round(perCycle/4),"tokens");
      console.log("across a ten-cycle isolated run:", B(cycle1)+B(SELF)+9*perCycle,
        "bytes ~", Math.round((B(cycle1)+B(SELF)+9*perCycle)/4), "tokens");'

    string                                                     chars   bytes   ~tokens @4B
    SELF_HOSTING_NOTICE (--append-system-prompt, every cycle)   1094    1096           274
    COMPLETION_NOTICE (cycle 1, gated on endsOnDone)             441     443           111
    NEEDS_REVIEW_NOTICE (every cycle bar a follow-up)            635     639           160
    DEFAULT_CONTINUATION_PROMPT (every resumed cycle)            136     136            34
    DEFAULT_DONE_PUSHBACK_PROMPT (instead, after a DONE)         536     536           134
    DEFAULT_ISOLATION_PREAMBLE (cycle 1, isolated run)           199     199            50
    SHARED_CHECKOUT_NOTICE (cycle 1, isolated run)               677     679           170
    DEFAULT_CONTINUED_WORK_PROMPT (cycle 1, continued branch)    364     364            91

    nextPrompt output at the shipped defaults:
      cycle 1, isolated            1974 bytes  ~   494 tokens
      cycle 1, not isolated        1092 bytes  ~   273 tokens
      cycle 2+, continuation        777 bytes  ~   194 tokens
      cycle 2+, DONE pushback      1177 bytes  ~   294 tokens

    per resumed cycle, app-authored text on the wire: 1873 bytes ~ 468 tokens
    across a ten-cycle isolated run: 19927 bytes ~ 4982 tokens

The `~tokens` column divides by four and is therefore an **estimate**, not a
measurement; the corpus fit above says the true figure for text that lands in a
conversation is higher.

**Every word this app writes into a ten-cycle run is about 4,982 tokens.** For
scale, the median long session carries 17,079,927 cache-read tokens over its
life (the second command in the first section), and one work-cycle handover
writes a median 231,644. The app's entire authored contribution across ten
cycles is **2% of one handover**, and about 0.03% of what a median long run
reads back. Any option that proposes to shorten these strings is optimising the
wrong three orders of magnitude, and that is worth establishing before the
survey rather than discovering inside it.

### The session lifecycle — which cycles resume and which open fresh

One variable decides, and it is hydrated from the row rather than zeroed:

    let sessionId: string | null = run.session_id;      src/lib/orchestrator.ts:6319

`nextPrompt` branches on `o.sessionId === null` (`:4330`) and `buildArgs` emits
`--resume` on `opts.resumeSessionId` (`:4874`); both are fed that one local. It
is written the moment the stream names it rather than when the cycle returns —
`adoptSession` (`:6357`) sets the local *and* the column, because writing it only
in the post-cycle UPDATE "left the column null however far the cycle had actually
got" (`:6350`–`:6353`, and `docs/agent/run-lifecycle.md:36`).

So a cycle opens a fresh conversation in exactly three cases: the run has never
had one; retention cleared `runs.session_id` because the transcript file went
(`src/lib/retention.ts:663`–`:667`, `docs/agent/retention.md:12`); or the row is
a different run — a workflow chain's second block, or a `continues_run` pick-up,
both of which get `continuedWorkNotice` and `priorWorkNotice` instead of a
resume.

The fourth case is a deliberate non-case, and it is the one that says how this
app values the conversation. When a resume fails twice, the run **stops** rather
than starting over: `looksLikeResumeFailure` retries once and then reports
"Could not resume this run's Claude Code session […] Its work is still on disk;
pick it up by hand with: claude --resume <id>" (`:7127`–`:7151`). The comment
above it says why — "the honest move is to stop and name the command rather than
quietly start a fresh session and lose the conversation the resume existed to
keep" (`:7115`–`:7117`). Any option that proposes to discard a conversation is
proposing the thing this branch refuses to do by accident.

### The folder — context this app does not author but does choose

`CLAUDE.md` in this repository is 15,172 bytes (`wc -c CLAUDE.md`). It is not in
the transcript:

    $ grep -c claudeMd ~/.claude/projects/-workspace--uf-worktrees-usagefoundry-721638d11c0b-1/6a2ccabb-6930-4cbd-908e-3d4522456136.jsonl
    0
    $ grep -rl 'work cycle", the code says' ~/.claude/projects | grep -c '\.jsonl$'
    0

So it arrives in the fixed
prefix the CLI builds and is invisible to every measurement above except as part
of that 31,575-token median intercept.

An attempt to isolate it across the five repositories this container has run in,
which have `CLAUDE.md` files of 0, 11, 7,079, 15,172 and 27,077 bytes, does not
succeed:

    $ node -e '
      const fs=require("fs"), path=require("path");
      const ROOT="/home/node/.claude/projects";
      const REPO={usagefoundry:15172, visualmerge:27077, vibehub:7079, rssdashboard:11, orient:0};
      const groups={};
      for(const d of fs.readdirSync(ROOT)){
        const m=/^-workspace--uf-worktrees-([a-z]+)/.exec(d); if(!m) continue;
        const repo=m[1]; if(!(repo in REPO)) continue;
        for(const f of fs.readdirSync(path.join(ROOT,d))){ if(!f.endsWith(".jsonl")) continue;
          const recs=fs.readFileSync(path.join(ROOT,d,f),"utf8").split("\n").filter(Boolean)
            .map(l=>{try{return JSON.parse(l)}catch{return null}}).filter(Boolean);
          let promptBytes=0, done=false;
          for(const r of recs){ if(done||r.isSidechain) continue;
            if(r.type==="user"){ const c=r.message&&r.message.content;
              const t=typeof c==="string"?c:(Array.isArray(c)?c.filter(b=>b.type==="text").map(b=>b.text).join(""):"");
              promptBytes+=Buffer.byteLength(t); continue; }
            if(r.type!=="assistant") continue;
            const u=r.message&&r.message.usage; if(!u) continue;
            const cw=u.cache_creation_input_tokens||0, cr=u.cache_read_input_tokens||0;
            if(cw+cr===0){ done=true; continue; }
            (groups[repo]??(groups[repo]=[])).push({cw,prompt:promptBytes,
              resid:cw-Math.round(promptBytes/4)});
            done=true; } } }
      const med=a=>{const s=[...a].sort((x,y)=>x-y); return s[Math.floor(s.length/2)];};
      console.log("repo           CLAUDE.md B    n   med opening write   med prompt B   med residual tok");
      const pts=[];
      for(const [r,a] of Object.entries(groups).sort((x,y)=>REPO[x[0]]-REPO[y[0]])){
        const mw=med(a.map(x=>x.cw)), mp=med(a.map(x=>x.prompt)), mr=med(a.map(x=>x.resid));
        console.log(r.padEnd(14),String(REPO[r]).padStart(11),String(a.length).padStart(5),
          String(mw).padStart(19),String(mp).padStart(15),String(mr).padStart(19));
        pts.push([REPO[r],mr]); }
      let n=0,sx=0,sy=0,sxx=0,sxy=0,syy=0;
      for(const [x,y] of pts){ n++; sx+=x; sy+=y; sxx+=x*x; sxy+=x*y; syy+=y*y; }
      const sl=(n*sxy-sx*sy)/(n*sxx-sx*sx);
      const r=(n*sxy-sx*sy)/Math.sqrt((n*sxx-sx*sx)*(n*syy-sy*sy));
      console.log("\nmedian residual ~ CLAUDE.md bytes over",n,"repos: slope",sl.toFixed(4),
        "tok/byte  intercept",((sy-sl*sx)/n).toFixed(0),"tok  r^2",(r*r).toFixed(3));'

    repo           CLAUDE.md B    n   med opening write   med prompt B   med residual tok
    orient                   0     3               11930            7637                9979
    rssdashboard            11     1               10458            4073                9440
    vibehub               7079    13               12605            6125               12086
    usagefoundry         15172   261               42380            5258               40403
    visualmerge          27077    16               16667            5392               14805

    median residual ~ CLAUDE.md bytes over 5 repos: slope 0.4631 tok/byte  intercept 12773 tok  r^2 0.165

r² of 0.165, and VisualMerge's 27 KB of `CLAUDE.md` produces a *smaller* opening
prefix than UsageFoundry's 15 KB. So the file's size does not order the
measurement and **this does not establish what `CLAUDE.md` costs.** What it does
establish is that a UsageFoundry run's opening turn writes a median 42,380
tokens of prefix beyond the shared 15,903-token base — two and a half times what
a VisualMerge run writes, on nearly identical prompt lengths (5,258 against
5,392 bytes) — and that the difference is not the one file anyone would blame.
And it is not fixed within UsageFoundry either:

    $ node -e '
      const fs=require("fs"),path=require("path"); const ROOT="/home/node/.claude/projects";
      const a=[];
      for(const d of fs.readdirSync(ROOT)){ if(!/^-workspace--uf-worktrees-usagefoundry/.test(d)) continue;
        for(const f of fs.readdirSync(path.join(ROOT,d))){ if(!f.endsWith(".jsonl")) continue;
          for(const l of fs.readFileSync(path.join(ROOT,d,f),"utf8").split("\n")){ if(!l) continue;
            let r; try{r=JSON.parse(l)}catch{continue}
            if(r.isSidechain||r.type!=="assistant") continue;
            const u=r.message&&r.message.usage; if(!u) continue;
            const cw=u.cache_creation_input_tokens||0, cr=u.cache_read_input_tokens||0;
            if(cw+cr===0) continue; a.push(cw); break; } } }
      a.sort((x,y)=>x-y); const q=f=>a[Math.floor(f*(a.length-1))];
      console.log("n",a.length,"min",q(0),"p10",q(.1),"p25",q(.25),"median",q(.5),
        "p75",q(.75),"p90",q(.9),"max",q(1));'

    n 261 min 10343 p10 15712 p25 34225 median 42380 p75 82283 p90 92085 max 132919

A run's opening prefix ranges over an order of magnitude on one repository, and
nothing measured here says what moves it.

Two other pieces of folder-borne context are chosen by this app and not measured
here. `--plugin-dir` decides which plugin directories' skills and hooks load
(`src/lib/plugins.ts:359`). The MCP config this app writes for a chat turn is
`src/app/api/mcp/` and `docs/agent/chat.md`'s subject, and it is not on a work
cycle's argv at all.

## What is out of reach, named plainly

- **The conversation belongs to the CLI.** This app hands it a prompt and a
  session id; every decision about what the request actually contains — the
  system block, the tool schemas, where cache breakpoints go, which TTL a write
  gets — is taken below `buildArgs` and is not expressible on any flag it emits.
  The clean 1h/5m split by thread is the proof: 26,194 turns and not one
  exception, from a mechanism this app has no name for.
- **The transcript is written by the CLI**, and it is a partial record. Thinking
  text is stripped (13,454 blocks, zero bytes retained). The system and
  environment blocks are absent — `grep -c system-reminder` over a container
  transcript returns `0`. Large tool outputs are spilled to
  `<session>/tool-results/*.txt` and replaced in the transcript by a
  `<persisted-output>` wrapper carrying a 2 KB preview:

      $ find /home/node/.claude/projects -path '*-workspace*/tool-results/*' -type f \
          -printf '%s\n' | awk '{s+=$1;n++} END{print "sidecar files",n,"bytes",s}'
      sidecar files 174 bytes 81720400

  81.7 MB of tool output the CLI already kept *out* of context without being
  asked, on this container alone.
- **Whatever compaction the CLI performs under `-p` is its own.** No record in
  this corpus carries an `isCompactSummary`, `compactMetadata`, `isCompact` or
  `summary` field:

      $ cd /home/node/.claude/projects && node -e '
        const fs=require("fs"),path=require("path"); const marks={}; let recs=0;
        for(const d of fs.readdirSync(".").filter(d=>d.startsWith("-workspace")))
          for(const f of fs.readdirSync(d)){ if(!f.endsWith(".jsonl")) continue;
            for(const l of fs.readFileSync(path.join(d,f),"utf8").split("\n")){ if(!l) continue;
              let r; try{r=JSON.parse(l)}catch{continue}
              recs++;
              for(const k of ["isCompactSummary","compactMetadata","summary","isCompact"])
                if(r[k]!==undefined) marks[k]=(marks[k]||0)+1; } }
        console.log("records",recs,"compaction markers",JSON.stringify(marks));'
      records 111845 compaction markers {}

  So either compaction did not happen in this window or it is not recorded here;
  which of those is true is **not established**.
- **A delegated turn's context is visible here only through attribution.**
  `attributionAgent` (`src/lib/transcripts.ts:263`–`264`) says which bucket a
  turn belongs to and nothing about what that turn carried. A sub-agent's
  conversation is a separate file under `<session>/subagents/`, and this app
  neither builds it nor reads it.

## What this proposal would prevent

Not "cost savings". The specific failure is this: **the largest single
identifiable line in this install's bill is a work-cycle handover re-writing a
conversation that did not change, and nothing in this app knows that is
happening.** 79 handovers in the rolling week cost $183.69 in cache writes
alone, a median $2.32 each, on conversations whose previous turn was a median
ten seconds earlier and whose one-hour TTL had 59 minutes left. 27% of handovers
in the same window paid $0.165 instead. Nothing on the run page, the dashboard or
in `run_events` distinguishes the two, because all three read cost and none reads
composition — the cycle that paid $2.34 to open with "Continue working on the
task" and the one that paid $0.17 for the same sentence are the same row.

The measurement supports a narrow claim and refuses a broad one, and the survey
has to know which it is answering.

It **refuses** the broad claim that this app can shorten conversations
profitably. 46% of a conversation is file contents an agent chose to read, and
the best available proxy says 39.5% of that is never referred to again — but
that proxy cannot distinguish "wasted" from "read and understood", the thinking
that would settle it is not in the transcript, and the app that would drop it
does not own the conversation. The app's own authored text is 4,982 tokens
across a ten-cycle run against a median 17 million carried tokens: three orders
of magnitude away from mattering. And the tail is a 1.9× on the last ten turns
of a long session, not an order of magnitude.

It **supports** the narrow claim that the boundaries this app *does* own are
priced wrongly and measured not at all. This app decides when a cycle ends and a
new one begins; it decides when a session is resumed and when a fresh one opens;
it decides what goes on the argv that precedes the conversation. Those three
decisions are worth, on the measured evidence, $183.69 a week in cache writes at
the handover, $95.74 at session openings, and an unmeasured share of a
31,575-token fixed prefix paid on all 16,605 container turns. The one nobody has
looked at is the biggest: 27% of handovers already hit the cache and 73% do not,
for a reason that is not the clock, not the CLI version and not the process
boundary — and until somebody names it, no option in this survey can be priced.

Which leaves the survey with a question it must settle before it is read, and one
it must not pre-empt. The question it must settle is whether it is answering the
broad claim or the narrow one, because they have different answers. The one it
must not pre-empt is the pin probe's: if the prefix that changes across a
handover turns out to be the CLI's own and nothing on this app's argv reaches it,
then every option aimed at the handover is priced at zero and what the
measurement still supports is smaller than any of them. A survey that ends
against building anything is a good outcome for this proposal rather than a
failed one, and it is on the table from here.
