# 診斷測試失敗的原因

devguard 不分析測試為什麼失敗（例如判斷 `ModuleNotFoundError` 是 import path 或 pytest `pythonpath` 設定造成的），只回報哪些測試失敗，並提示在元件目錄自行執行測試查看完整訊息。

## Why this is out of scope

`check --full` 的職責是確認測試通過、覆蓋率達標。測試失敗的原因屬於專案本身：匯入方式、套件佈局、`conftest.py`、pytest 設定，每個專案都不同。要給出有用的診斷，devguard 必須解析各測試框架的錯誤輸出，並猜測專案的寫法，猜錯時反而誤導。

目前的 finding 已經列出失敗或 ERROR 的測試 id，並提示要執行的指令。使用者照著執行，就能看到測試框架本身的完整錯誤訊息，這比 devguard 的猜測更準確。

例如 #71 的情況：專案以 `src.` 為前綴匯入、`package = false`，又沒有設定 `pythonpath`。直接執行 `uv run pytest` 就會看到 `No module named 'src'`，專案在 `[tool.pytest.ini_options]` 加上 `pythonpath = ["."]` 即可解決。

## Prior requests

- #71: pytest 因匯入錯誤失敗時，提示可以指出 import path 問題
