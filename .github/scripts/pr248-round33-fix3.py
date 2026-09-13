from pathlib import Path

p = Path('src/browser/remote/controller.ts')
s = p.read_text()
old = 'held.watchDetachGen !== consumerIntent'
count = s.count(old)
if count != 3:
    raise SystemExit(f'expected 3 popup detach guards, found {count}')
s = s.replace(old, '(held.watchDetachGen ?? 0) !== consumerIntent')
p.write_text(s)
