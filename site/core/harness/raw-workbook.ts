const rawWorkbookRequestPattern = /原始(?:数据|表格|工作簿|明细)|逐行(?:数据|明细)?|单元格|工作表|第\s*\d+\s*行|读完|全部原始行|全量(?:数据|扫描|分析)|完整(?:读取|扫描|分析)|整份(?:表格|工作簿|数据)|全表|raw\s*(?:data|rows?|workbook)/iu;

const rawWorkbookFollowUpPattern = /^\s*(?:那|再|继续|然后|下一|上一|这个|该|刚才|上面|下面|还有|详细|展开|为什么|怎么)/u;

export function instructionRequestsRawWorkbook(instruction: string, previousInstruction?: string): boolean {
  if (rawWorkbookRequestPattern.test(instruction)) return true;
  return Boolean(previousInstruction
    && rawWorkbookRequestPattern.test(previousInstruction)
    && rawWorkbookFollowUpPattern.test(instruction));
}
