/** Decorative line drawing; it does not represent a user's data or analysis. */
export function StudioArtwork({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 280 180" fill="none" aria-hidden="true">
      <path d="M20 152h240M42 28v133M240 18v143" stroke="#dedbd6" strokeDasharray="3 4" />
      <path d="M67 24h161v120H67z" fill="#eae7e2" stroke="#b7b2ab" />
      <path d="M58 16h161v120H58z" fill="#fbfaf8" stroke="#8e8983" />
      <path d="M58 39h161" stroke="#aaa59f" />
      <circle cx="69" cy="28" r="2" fill="#262522" />
      <circle cx="77" cy="28" r="2" fill="#aaa59f" />
      <circle cx="85" cy="28" r="2" fill="#d1cdc7" />
      <path d="M73 53h38m-38 6h23" stroke="#9a958f" strokeWidth="2" />
      <path d="M73 115h130M73 94h130M73 73h130" stroke="#e3e0db" />
      <path d="m74 105 20-14 19 7 22-27 19 7 22-22 26 8" stroke="#252421" strokeWidth="2" strokeLinecap="square" />
      <circle cx="176" cy="56" r="3.5" fill="#252421" />
      <path d="M28 94h97v67H28z" fill="#fbfaf8" stroke="#8e8983" />
      <path d="M40 107h31" stroke="#b8b2aa" strokeWidth="2" />
      <path d="M41 146h12v-19H41zm20 0h12v-29H61zm20 0h12v-15H81zm20 0h12v-36h-12z" fill="#292825" />
      <path d="M153 106h94v55h-94z" fill="#fbfaf8" stroke="#8e8983" />
      <circle cx="175" cy="133" r="13" stroke="#d5d0c9" strokeWidth="6" />
      <path d="M175 120a13 13 0 1 1-13 13" stroke="#292825" strokeWidth="6" />
      <path d="M199 125h34m-34 8h25m-25 8h29" stroke="#b8b2aa" strokeWidth="2" />
      <path d="M235 40v12m-6-6h12M33 70v8m-4-4h8" stroke="#8e8983" />
    </svg>
  );
}
