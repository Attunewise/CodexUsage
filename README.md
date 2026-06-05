# CodexUsage

CodexUsage is a Codex skill for reporting local Codex token usage and estimated spend. It shows totals by model and by month, including cached input, output, reasoning, unknown tokens, and estimated dollar cost.

## Example Output

### Codex Usage

Generated: 2026-06-05T20:05:28.038Z
Sessions: 29 (2 scanned, 27 cached)
Total tokens: 3,461,427,128
Estimated cost: $2,720.2667

#### By Model

| Model | Sessions | Events | Input | Cached | Output | Reasoning | Unknown | Total | Cost |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| openai/gpt-5.5 | 25 | 21,538 | 3,148,415,650 | 3,041,851,520 | 8,424,619 | 2,678,761 | 60,267,111 | 3,217,107,380 | $2,607.8205 |
| openai/gpt-5.4 | 7 | 1,659 | 238,739,623 | 226,616,576 | 930,256 | 420,166 | 4,583,787 | 244,253,666 | $112.3751 |
| openai/gpt-5.4-mini | 1 | 2 | 0 | 0 | 0 | 0 | 35,581 | 35,581 | $0.0267 |

#### By Month

| Month | Sessions | Models | Events | Input | Cached | Output | Reasoning | Unknown | Total | Cost |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-05 | 22 | 4 | 12,970 | 1,861,065,591 | 1,794,173,312 | 5,118,528 | 1,666,522 | 39,208,005 | 1,905,392,124 | $1,534.6552 |
| 2026-06 | 9 | 2 | 10,230 | 1,526,119,961 | 1,474,302,208 | 4,236,569 | 1,432,607 | 25,678,474 | 1,556,035,004 | $1,185.6115 |
