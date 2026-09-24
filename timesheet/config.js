// JIA AN 工时台 · Airtable 结构配置（不含任何密钥；访问令牌只保存在使用者自己的浏览器里）
// 字段一律用 field ID 读写，Airtable 里改字段名不会影响本工具。
window.JIAAN_TS_CONFIG = {
  ops: {            // 03｜JIA AN｜Operations & Projects
    base: "appSJiA7IxAvsmNWw",
    projects: { table: "tblRPCkehnOQlisX0", name: "fldLVoRNx83xZEXni", uid: "fldAjdVGbBmv9v3bE", org: "fldSumyAVv6moFsgJ", status: "fld9DjPahqQRFzlsP", cycle: "fldwgRRzIp5J7bwhu" },
    cranes:   { table: "tblumkqQLprQ2flzu", label: "fldzmkkew8XZbW7o8", uid: "fld83POYyx4fqasMG", project: "fldtCPzQP2b8YjDm1", no: "fldYdxYD5CeuMtbNI", shift: "fldLpslbarpvhfOSa", status: "fldb05BC2WlLwmVRl" },
    timesheets: { table: "tbluHSctb0G47U8KB",
      uid: "fldoSyfUiHFYcCvKZ", date: "fld9tVM8f50BwmZoW", projectLink: "fldABikv1rtWI6VAE", projectUid: "fldffjkgnCH2CX9w9",
      craneNo: "fld34UyUKVdnnJ2XX", craneUid: "fldSdSpTmxerrQ2c5", craneLink: "fldzc7mjZWEQDoPCs",
      worker: "fldS4kGySxU0Ju8U2", workerUid: "fldemIpHIesvgj633", shift: "fldajLLkftX872Yds",
      start: "fldUdRX2MNYeUU1S2", end: "fldodVdu4AwwFyP2V", ltw: "fldNpr4ZUOiSjsUrB", card: "fldbGQUT5o1kBTdj3",
      status: "fld99LH0QsQSbF3M3", reject: "fld3DGq80tmN11KyS", source: "fldw7o0ZxNDlkghqS",
      verifiedBy: "fldH0afJVEvNhRIPI", verifiedDate: "fldTBipDiZJ50cFG9", notes: "fldczG4ZYCf6ZC2Yd" },
    adjustments: { table: "tblwupuWGTgkTRDNG",
      key: "fldR6gldgA3ijWRPm", project: "fldWfCdpDN3AOCri4", month: "fld3U8Bm7N4Hiisi2", worker: "fldtvEyjuTDiEhCCQ",
      crane: "fldZNQnAaIm1XVss0", shiftClass: "fldiFWetj8WCIdyQX", code: "fldAtRHoRA3W9Gp10", from: "fldK2XK4lVfKnEMRD",
      to: "fldOCrOBIiN6LH1Dd", manualAbsent: "fldpLPadhSnjg6Ppe", otAdj: "fldvmVftFxkp2ePLL", other: "fldWkVOAqIKZ3SsJb", notes: "flds819YDmQCtPBND" },
  },
  hr: {             // 04｜JIA AN｜Workforce & HR
    base: "appbvwlPj8GxzmN1B",
    workers: { table: "tbloZxcA1O2o9yiuC", name: "fld9ACvaTCuTXIT7t", uid: "fldAJMPNzZcJAoNqN", role: "fldffMW2E4Sr5MsEB", status: "fldNr9Gsxq649029Y", alias: "fldDOSdt9GJWu4AZ8" },
  },
  com: {            // 02｜JIA AN｜Commercial & Clients
    base: "app2qjzFpdEr4JZYu",
    rates: { table: "tbl76MVm6pC77T1wg", project: "fld3nwrcjsTzN8RXN", month: "fld6oH9gPJb6reqlz", status: "fldlFQ3di9itvLWkD", rows: "fld1uoEdwSZ7UMNJG", otSummary: "fld43NhlACpFLGR2q" },
  },
  // 新加坡公共假日（来源：总包 Claim 计算表 → Holidays，权威源 MOM）。count=false 的日期不判公休。
  // 每年 MOM 公布后在这里加一行即可。
  holidays: [
    ["2026-01-01","New Year's Day 元旦",true],["2026-02-17","Chinese New Year 初一",true],["2026-02-18","Chinese New Year 初二",true],
    ["2026-03-21","Hari Raya Puasa 开斋节",true],["2026-04-03","Good Friday 耶稣受难日",true],["2026-05-01","Labour Day 劳动节",true],
    ["2026-05-27","Hari Raya Haji 哈芝节",true],["2026-05-31","Vesak Day 卫塞节",true],["2026-06-01","Vesak Day 补假",true],
    ["2026-08-09","National Day 国庆日",true],["2026-08-10","National Day 补假",true],["2026-11-08","Deepavali 屠妖节",true],
    ["2026-11-09","Deepavali 补假",true],["2026-12-25","Christmas Day 圣诞节",true],
  ],
};
