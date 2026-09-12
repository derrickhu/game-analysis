#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""花花小游戏留存诊断脚本 - 只读分析"""
import sqlite3
from datetime import datetime, timezone, timedelta
from collections import defaultdict, Counter

DB = 'file:data/game-analysis.sqlite?mode=ro'
TZ = timezone(timedelta(hours=8))

con = sqlite3.connect(DB, uri=True)
cur = con.cursor()


def ts2d(ts):
    if not ts:
        return None
    # 兼容秒/毫秒
    v = ts / 1000 if ts > 1e11 else ts
    return datetime.fromtimestamp(v, TZ).strftime('%Y-%m-%d')


def line(t=''):
    print(t)


def sec(title):
    line()
    line('=' * 66)
    line(title)
    line('=' * 66)


# ---------------------------------------------------------------- 0. 数据范围
sec('0. 数据总览')
cur.execute("SELECT game_key, COUNT(*) FROM player_facts GROUP BY game_key")
for r in cur.fetchall():
    line(f'  player_facts   {r[0]}: {r[1]} 玩家')
cur.execute("SELECT game_key, COUNT(*), COUNT(DISTINCT user_id) FROM analytics_events GROUP BY game_key")
for r in cur.fetchall():
    line(f'  analytics_events {r[0]}: {r[1]} 事件 / {r[2]} 用户')
cur.execute("SELECT game_key, MIN(event_ts), MAX(event_ts) FROM analytics_events GROUP BY game_key")
for g, a, b in cur.fetchall():
    line(f'  {g} 事件时间范围: {ts2d(a)} ~ {ts2d(b)}')

GAME = 'huahua'

# ---------------------------------------------------------------- 1. 新手漏斗
sec('1. 新手引导漏斗 (huahua)')
cur.execute("""
SELECT tutorial_step, COUNT(*) c FROM player_facts
WHERE game_key=? GROUP BY tutorial_step ORDER BY c DESC LIMIT 15
""", (GAME,))
tut = cur.fetchall()
line('  tutorial_step 分布:')
for step, c in tut:
    line(f'    {step!r:20} -> {c} 人')

cur.execute("SELECT COUNT(*) FROM player_facts WHERE game_key=?", (GAME,))
total = cur.fetchone()[0]
step1 = dict(tut).get('1', 0)
finished = sum(c for s, c in tut if s not in ('1', '', None))
line(f'  总玩家: {total}')
line(f'  卡在 step=1: {step1} ({step1/total*100:.1f}%)')
line(f'  推进过 step>1: {finished} ({finished/total*100:.1f}%)')

# ---------------------------------------------------------------- 2. 核心行为
sec('2. 核心行为达成率 (huahua)')
cur.execute("SELECT COUNT(*) FROM player_facts WHERE game_key=? AND merge_count_total=0", (GAME,))
zero_merge = cur.fetchone()[0]
cur.execute("SELECT COUNT(*) FROM player_facts WHERE game_key=? AND delivered_orders_total=0", (GAME,))
zero_order = cur.fetchone()[0]
cur.execute("SELECT COUNT(*) FROM player_facts WHERE game_key=? AND merge_count_total>0", (GAME,))
has_merge = cur.fetchone()[0]
line(f'  从未合成过: {zero_merge} / {total} = {zero_merge/total*100:.1f}%')
line(f'  从未交付订单: {zero_order} / {total} = {zero_order/total*100:.1f}%')
line(f'  有过合成行为: {has_merge} ({has_merge/total*100:.1f}%)')

cur.execute("""
SELECT CASE WHEN merge_count_total=0 THEN '0'
 WHEN merge_count_total<=5 THEN '1-5'
 WHEN merge_count_total<=20 THEN '6-20'
 WHEN merge_count_total<=50 THEN '21-50'
 WHEN merge_count_total<=200 THEN '51-200'
 ELSE '200+' END b, COUNT(*) FROM player_facts WHERE game_key=?
 GROUP BY b
""", (GAME,))
line('  合成次数分桶:')
order_b = ['0', '1-5', '6-20', '21-50', '51-200', '200+']
res = dict(cur.fetchall())
for b in order_b:
    c = res.get(b, 0)
    line(f'    {b:8} {c:6} 人  {"#" * int(c / total * 60)}')

# ---------------------------------------------------------------- 3. 等级
sec('3. 等级分布 (huahua)')
cur.execute("SELECT level, COUNT(*) FROM player_facts WHERE game_key=? GROUP BY level ORDER BY level", (GAME,))
lv = cur.fetchall()
for l, c in lv:
    bar = '#' * int(c / total * 50)
    line(f'  Lv.{l:<3} {c:6} 人 {c/total*100:5.1f}% {bar}')
cur.execute("SELECT AVG(level), COUNT(*) FROM player_facts WHERE game_key=? AND level>0", (GAME,))
a, n = cur.fetchone()
line(f'  有等级用户均值: {a:.2f} (n={n})')

# ---------------------------------------------------------------- 4. 留存
sec('4. 留存分析 (huahua)')
# 用事件表构建每个用户的活跃日期集合
cur.execute("""
SELECT user_id, event_ts FROM analytics_events
WHERE game_key=? AND user_id IS NOT NULL AND user_id!=''
""", (GAME,))
user_days = defaultdict(set)
for uid, ts in cur.fetchall():
    d = ts2d(ts)
    if d:
        user_days[uid].add(d)

line(f'  有事件的用户数: {len(user_days)}')
if user_days:
    first_day = {u: min(days) for u, days in user_days.items()}
    # 新增按天
    new_by_day = Counter(first_day.values())
    line('  新增用户按日:')
    for d in sorted(new_by_day):
        line(f'    {d}: {new_by_day[d]} 人')

    # 留存矩阵
    line()
    line('  留存率（按首次活跃日 cohort，分母=当日新增）:')
    cohorts = sorted(new_by_day)
    line(f'    {"cohort":<12}{"新增":>6}{"D1":>8}{"D2":>8}{"D3":>8}{"D5":>8}{"D7":>8}')
    for d in cohorts:
        if new_by_day[d] < 20:
            continue
        d0 = datetime.strptime(d, '%Y-%m-%d')
        base = [u for u, fd in first_day.items() if fd == d]
        row = [d, str(len(base))]
        for nd in (1, 2, 3, 5, 7):
            target = (d0 + timedelta(days=nd)).strftime('%Y-%m-%d')
            alive = sum(1 for u in base if target in user_days[u])
            row.append(f'{alive/len(base)*100:.1f}%')
        line(f'    {row[0]:<12}{row[1]:>6}{row[2]:>8}{row[3]:>8}{row[4]:>8}{row[5]:>8}{row[6]:>8}')

    # 整体 D1（用快照/事实表口径：active_date 是否 >= 次日）
    line()
    line('  整体次日回访（快照口径 active_date）:')
    cur.execute("""
    SELECT active_date, COUNT(*) FROM player_facts WHERE game_key=? GROUP BY active_date ORDER BY active_date
    """, (GAME,))
    for d, c in cur.fetchall():
        line(f'    最后活跃 {d}: {c} 人')

# ---------------------------------------------------------------- 5. 会话
sec('5. 会话与时长 (huahua)')
cur.execute("""
SELECT event_name, COUNT(*) c, COUNT(DISTINCT user_id) u FROM analytics_events
WHERE game_key=? GROUP BY event_name ORDER BY c DESC
""", (GAME,))
line('  事件分布:')
for n, c, u in cur.fetchall():
    line(f'    {n:18} {c:6} 次 / {u:6} 人')

# 会话时长
cur.execute("""
SELECT user_id, session_id, MIN(event_ts), MAX(event_ts),
       SUM(CASE WHEN event_name='session_end' THEN 1 ELSE 0 END)
FROM analytics_events WHERE game_key=? AND session_id IS NOT NULL AND session_id!=''
GROUP BY user_id, session_id
""", (GAME,))
durs = []
for uid, sid, mn, mx, has_end in cur.fetchall():
    if mx and mn and mx > mn:
        durs.append((mx - mn) / 1000.0)
if durs:
    durs.sort()
    n = len(durs)
    line(f'  会话样本: {n}')
    line(f'    时长中位数: {durs[n//2]:.1f}s   均值: {sum(durs)/n:.1f}s')
    line(f'    P25: {durs[int(n*0.25)]:.1f}s  P75: {durs[int(n*0.75)]:.1f}s  P90: {durs[int(n*0.9)]:.1f}s')
    for th in (10, 30, 60, 180, 300):
        c = sum(1 for d in durs if d >= th)
        line(f'    >= {th}s 的会话: {c} ({c/n*100:.1f}%)')

# 每人事件数
cur.execute("""
SELECT user_id, COUNT(*) FROM analytics_events WHERE game_key=? AND user_id!=''
GROUP BY user_id
""", (GAME,))
cnts = [c for _, c in cur.fetchall()]
if cnts:
    cnts.sort()
    n = len(cnts)
    line(f'  人均事件数: 中位数 {cnts[n//2]}, 均值 {sum(cnts)/n:.1f}, P90 {cnts[int(n*0.9)]}')

# ---------------------------------------------------------------- 6. 关卡
sec('6. 关卡漏斗 (huahua)')
cur.execute("""
SELECT event_name, COUNT(*) c, COUNT(DISTINCT user_id) u FROM analytics_events
WHERE game_key=? AND event_name IN ('level_start','level_clear','session_start','login')
GROUP BY event_name
""", (GAME,))
ev = {n: (c, u) for n, c, u in cur.fetchall()}
ls = ev.get('level_start', (0, 0))
lc = ev.get('level_clear', (0, 0))
line(f'  level_start: {ls[0]} 次 / {ls[1]} 人')
line(f'  level_clear: {lc[0]} 次 / {lc[1]} 人')
if ls[0]:
    line(f'  通关率(次数口径): {lc[0]/ls[0]*100:.1f}%')
if ls[1]:
    line(f'  有过通关的人占尝试者: {lc[1]/ls[1]*100:.1f}%')

# ---------------------------------------------------------------- 7. 广告
sec('7. 广告变现 (huahua)')
cur.execute("""
SELECT ad_type, scene, SUM(ad_request_cnt), SUM(ad_show_cnt), SUM(ad_click_cnt),
       SUM(ad_complete_cnt), SUM(ad_error_cnt), SUM(ad_revenue_estimated_cny), AVG(ecpm_used)
FROM analytics_ad_minute WHERE game_key=? GROUP BY ad_type, scene ORDER BY SUM(ad_show_cnt) DESC
""", (GAME,))
rows = cur.fetchall()
if rows:
    line(f'  {"类型":<10}{"场景":<16}{"请求":>7}{"曝光":>7}{"点击":>7}{"完成":>7}{"错误":>6}{"收入":>9}{"eCPM":>8}')
    for t in rows:
        line(f'  {str(t[0]):<10}{str(t[1]):<16}{t[2]:>7}{t[3]:>7}{t[4]:>7}{t[5]:>7}{t[6]:>6}{t[7] or 0:>9.2f}{(t[8] or 0):>8.1f}')
    tr = sum(t[2] for t in rows); ts_ = sum(t[3] for t in rows)
    te = sum(t[5] for t in rows)
    line(f'  曝光/请求 = {ts_/tr*100:.1f}%' if tr else '')
    line(f'  完成/曝光 = {te/ts_*100:.1f}%' if ts_ else '')
else:
    line('  无广告分钟数据')
cur.execute("""
SELECT event_name, COUNT(*), COUNT(DISTINCT user_id) FROM analytics_events
WHERE game_key=? AND event_name LIKE 'ad%' GROUP BY event_name
""", (GAME,))
line('  广告事件:')
for n, c, u in cur.fetchall():
    line(f'    {n:14} {c:5} 次 / {u:5} 人')

# ---------------------------------------------------------------- 8. 分享
sec('8. 社交传播 (huahua)')
cur.execute("""
SELECT event_name, COUNT(*), COUNT(DISTINCT user_id) FROM analytics_events
WHERE game_key=? AND event_name LIKE 'share%' GROUP BY event_name
""", (GAME,))
r = cur.fetchall()
if r:
    for n, c, u in r:
        line(f'  {n}: {c} 次 / {u} 人')
else:
    line('  无分享事件')

con.close()
line()
line('分析完成')
