import { Alert, Collapse, Space, Typography } from 'antd';

import { LtvPage } from './LtvPage';
import { RoiPage } from './RoiPage';

const { Text } = Typography;

/**
 * 商业化分析页：把“用户值多少钱（LTV）”和“买用户花多少钱（ROI）”放在同一个经营决策流里。
 *
 * 页面顺序按经营动作设计：
 * 1. 先看是否盈利、明天投多少、是否加投/降预算；
 * 2. 再补录真实投放和微信收入；
 * 3. 最后展开 LTV/商业化能力，解释为什么能赚或亏。
 */
export function CommercialPage() {
  return (
    <Space orientation="vertical" size="middle" style={{ width: '100%' }}>
      <Alert
        type="info"
        showIcon
        message="商业化分析 · ROI 决策 + LTV 回收"
        description={
          <Space orientation="vertical" size={0}>
            <Text>
              这个页面合并“ROI 录入”和“商业化 LTV”：先回答能不能赚钱、明天投多少，再用 LTV/ARPDAU/广告漏斗解释回收能力。
            </Text>
            <Text type="secondary">
              ROI 以你录入的真实投放花费和微信真实收入为准；LTV 当前仍是基于预估 eCPM 的广告估算收入，用于趋势和早期回收判断。
            </Text>
          </Space>
        }
      />

      <RoiPage />

      <Collapse
        defaultActiveKey={['ltv']}
        items={[
          {
            key: 'ltv',
            label: 'LTV 与商业化能力（ARPDAU / 广告漏斗 / Cohort 回收）',
            children: <LtvPage />,
          },
        ]}
      />
    </Space>
  );
}
