/** The Shayyek logo (words + mark): dark words on light screens, white words in dark mode. */
const base = import.meta.env.BASE_URL;

export function BrandLogo({ className = "h-10" }: { className?: string }) {
  return (
    <>
      <img src={`${base}brand/logo-light.svg`} alt="شيّك Shayyek" className={`${className} w-auto dark:hidden`} />
      <img src={`${base}brand/logo-dark.svg`} alt="شيّك Shayyek" className={`${className} hidden w-auto dark:block`} />
    </>
  );
}

/** The mark alone (the gradient plane), for tight spots. */
export function BrandMark({ className = "h-9 w-9" }: { className?: string }) {
  return <img src={`${base}brand/mark.svg`} alt="شيّك" className={`${className} object-contain`} />;
}
