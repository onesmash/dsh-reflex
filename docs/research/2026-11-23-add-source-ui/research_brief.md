# research-nex 简报：加数据源这个界面，交互该长什么样

- 模式：**Flash**（窄问题、要结论不要长篇）；profile：technical-detail
- 范围：只问"命名与流程结构有没有行业先例"，不问视觉风格
- 问题树（MECE，两层）：
  1. 加一个数据源/自动化，主流工具切成几段？命名是什么？
  2. "多久看一次"是独立参数还是塞在触发条件里？
  3. 创建之前要不要先测/先校验？
  4. 新源要不要把存量当新事件处理一次？
- 产出见 `claim_evidence_map.json` / `statement_support_matrix.json`
- 结论落到设计上：**TRIGGER 有先例（Zapier/IFTTT/HA）、EVERY 有先例（n8n 的 Every X）、
  「试跑」与「首跑只建水位」都有先例（Zapier 的 Test 阶段与"只处理发布后的新数据"）；
  FEED 没有先例，是本插件自造的词**（见 open_gaps）。
