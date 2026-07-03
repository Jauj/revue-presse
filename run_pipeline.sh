#!/bin/bash
# Pipeline test script — runs all phases sequentially
BASE="https://revue-presse.jeanneaj.workers.dev"
LOG="/home/z/my-project/pipeline_test.log"

echo "=== PIPELINE TEST $(date) ===" > "$LOG"

run_phase() {
  local name="$1"
  local max_time="$2"
  echo "--- $name --- $(date +%H:%M:%S)" >> "$LOG"
  local result=$(curl -s --max-time "$max_time" -X POST "$BASE/trigger/$name" -H 'Content-Type: application/json' 2>&1)
  local success=$(echo "$result" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('success',False))" 2>/dev/null)
  echo "  success=$success" >> "$LOG"
  
  # Extract research info for COT2
  if [ "$name" = "cot2" ]; then
    echo "$result" | python3 -c "
import sys,json;d=json.load(sys.stdin)
r=d.get('research',{})
print(f'  research: {r.get(\"found\",0)}/{r.get(\"requests\",0)} found, skipped={r.get(\"skipped\",False)}')
for k,v in d.get('stages',{}).items():
 if isinstance(v,dict) and 'finished' in v: print(f'  {k}: {v.get(\"provider\")} {v.get(\"length\")}c')
" >> "$LOG" 2>/dev/null
  fi
  
  # Extract stages for other phases
  if [ "$name" != "cot2" ]; then
    echo "$result" | python3 -c "
import sys,json;d=json.load(sys.stdin)
for k,v in d.get('stages',{}).items():
 if isinstance(v,dict) and 'finished' in v: print(f'  {k}: {v.get(\"provider\")} {v.get(\"length\")}c')
if d.get('emailId'): print(f'  email: {d[\"emailId\"][:20]}...')
if d.get('subject'): print(f'  subject: {d[\"subject\"]}')
if d.get('error'): print(f'  ERROR: {d[\"error\"][:200]}')
" >> "$LOG" 2>/dev/null
  fi
  
  if [ "$success" = "False" ]; then
    echo "$result" | python3 -c "import sys,json;d=json.load(sys.stdin);print(f'  ERROR: {d.get(\"error\",\"?\")[:300]}')" >> "$LOG" 2>/dev/null
    echo "FAILED at $name" >> "$LOG"
    echo "PIPELINE_FAILED"
    return 1
  fi
  return 0
}

run_phase "fetch" 120 || { cat "$LOG"; exit 1; }
run_phase "cot1" 360 || { cat "$LOG"; exit 1; }
run_phase "cot2" 600 || { cat "$LOG"; exit 1; }
run_phase "cot3" 600 || { cat "$LOG"; exit 1; }
run_phase "deliver" 120 || { cat "$LOG"; exit 1; }

echo "=== PIPELINE COMPLETE ===" >> "$LOG"
cat "$LOG"