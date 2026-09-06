const ICP_LOOKUP_URL = "https://beian.miit.gov.cn/";
const MAX_ICP_LICENSE_LENGTH = 80;

export function normalizeIcpLicense(value: string | undefined): string | null {
  const normalized = value?.trim().replace(/[ \t]+/gu, " ") ?? "";
  if (!normalized || normalized.length > MAX_ICP_LICENSE_LENGTH || /[\u0000-\u001f\u007f]/u.test(normalized)) return null;
  return normalized;
}

export function SiteComplianceFooter({ license }: { license: string | undefined }) {
  const normalizedLicense = normalizeIcpLicense(license);
  if (!normalizedLicense) return null;
  return (
    <footer className="site-compliance-footer" aria-label="网站备案信息">
      <a href={ICP_LOOKUP_URL} target="_blank" rel="noreferrer">{normalizedLicense}</a>
    </footer>
  );
}
