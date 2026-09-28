FOOD RADAR V2

電腦啟動：
1. 安裝 Node.js LTS
2. VS Code 開啟這個資料夾
3. 終端機輸入：npm install
4. 再輸入：npm start
5. 瀏覽器開啟：http://localhost:3000

手機：
如果只是電腦 localhost，手機不能直接用 localhost。
要讓同一 Wi-Fi 的手機測試，啟動後用電腦區網 IP，例如 http://192.168.1.10:3000。
正式公開網站則建議部署到 HTTPS 網站，手機即可正常使用定位。

搜尋資料使用 OpenStreetMap / Overpass。公開服務是 best-effort，網站已設計多個 Overpass endpoint fallback，但正式商業化大量流量時應改用自己的資料服務或付費 Places API。
