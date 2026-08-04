import { Link } from 'react-router-dom';

interface Props<T> {
  title: string;
  prevDest?: string;
  prevState?: T;
}

export const PageHeader = <T,>(props: Props<T>): JSX.Element => {
  const { title, prevDest, prevState } = props;

  return (
    <div className='col-12'>
      <div className='page-header'>
        {title && <h1>{title}</h1>}
      {prevDest && (
        <div>
          <Link
            to={{
              pathname: prevDest,
              state: prevState
            }}
            className='back-link'
          >
            Back
          </Link>
        </div>
      )}
      </div>
    </div>
  );
};
