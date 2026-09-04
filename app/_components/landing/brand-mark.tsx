export function BrandMark() {
  return (
    <svg
      aria-hidden="true"
      className="brand-mark"
      viewBox="0 0 40 40"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        className="brand-mark__frame"
        d="M20 2.5 35.2 11v18L20 37.5 4.8 29V11L20 2.5Z"
      />
      <path
        className="brand-mark__relay"
        d="m12.5 15.7 7.5-4.2 7.5 4.2v8.6L20 28.5l-7.5-4.2v-8.6Z"
      />
      <circle className="brand-mark__node" cx="20" cy="20" r="2.7" />
    </svg>
  );
}
