# JIA AN 工时台（Timesheet）

**网址：https://jiaan-construction.github.io/timesheet/**（办公室和班组长用，不要发给工人）

**主管每日录入网址：https://jiaan-construction.github.io/timesheet/form/**（固定不变；会自动跳到 Airtable 表单，并隐藏带入 Source = Supervisor Form、Status = Submitted）。表单链接写在 `config.js` 的 `workerForm`。工人不碰 Airtable。

流程分四层，互不替代：**排班计划**（备忘录）→ **现场申报**（主管每日录入，Submitted）→ **凭证核验**（办公室对照工卡 / 总包签字单，Verified）→ **财务 / Claim**（只用 Verified）。

塔吊司机工时的录入、核验和 Claim 计算。数据全部在 Airtable，这个页面本身不存任何数据。

## 数据在哪

| 内容 | Airtable 位置 |
|---|---|
| 每条工时（含工卡照片） | 03｜Operations & Projects → **05｜Timesheets（工时）** |
| Claim 人工调整项（计算表黄格） | 03｜Operations & Projects → **06｜Timesheet Claim Adjustments** |
| 工地 / 塔吊 | 03 → 01｜Projects & Sites、02｜Cranes（只读） |
| 司机 | 04｜Workforce & HR → 01｜Workers（只读） |
| 费率 | 02｜Commercial & Clients → 04｜Project Rates 的 **Template Rate Rows**（只读） |
| 公共假日 | 本目录 `config.js` 的 `holidays`（每年 MOM 公布后加一行） |

## 流程

1. **按天录入**：选工地、日期，按塔吊填司机和上下班时间；可「照抄前一天」。主管用每日录入表交的「现场申报」会以黄色出现在对应格子里，要到「核验工卡」里核实后才进 Claim。
2. **核验工卡**：勾选记录 → 附工卡（照片/PDF，≤5MB）→ 标记已核验。没有工卡不能核验。
3. **Claim 计算**：按《总包 Claim 计算表》V2 口径逐人逐 TC 计算，只算已核验工时；可导出 CSV。

## 计算口径（与 Excel 模板 2026-09-03 D2 版一致）

- 平日白班 OT = 08:00 前 + 17:00 后；上班 ≥ 17:00 为夜班，全程 OT；周日/公休 = 跨度 − 午休。
- 午休 12:00–13:00，只在真跨过时扣 1h；LTW = Y 补 1h；上下班同一时刻 = 连做 24 小时。
- 包干制请款小时 = OT 合计；纯计时 = 总计费工时 + LTW；缺勤折算 = 包干 ÷ 应工作天数 × 缺勤（「整月不折算」除外）。
- 已用 2026-08 测试数据与 Excel（LibreOffice 重算）逐日对账：LBD $8,130.00、CHEC-PRIMA-TC2 $10,880.00，一致。

## 访问令牌

第一次使用要在「设置」里贴 Airtable 个人访问令牌（scopes：`data.records:read`、`data.records:write`、`schema.bases:read`；access 只选 02、03、04 三个 base）。令牌只存在使用者自己的浏览器里，**不要写进这个仓库**。

## 文件

- `index.html` 页面与样式
- `app.js` 逻辑（Airtable 读写、Claim 计算）
- `config.js` Airtable 表 / 字段 ID 与公共假日（不含密钥）
