interface Props {
  children: JSX.Element | JSX.Element[];
  classes?: string;
}

export const Layout = (props: Props): JSX.Element => {
  const rowClasses = `row g-4 py-4 py-lg-5 ${props.classes || ''}`;

  return (
    <main className='app-main'>
      <div className='container-lg'>
        <div className={rowClasses}>{props.children}</div>
      </div>
    </main>
  );
};
