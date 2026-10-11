import { tagTextColor } from '../../utils/sharedTags';

export const TagChip = (props: { name: string; color?: string | null; active?: boolean; onClick?: () => void }): JSX.Element => {
  const style = props.color ? { background: props.color, color: tagTextColor(props.color), borderColor: props.color } : undefined;
  const className = `tag-chip${props.active === false ? ' is-off' : ''}`;
  return props.onClick ? (
    <button type='button' className={className} style={style} onClick={props.onClick} aria-pressed={props.active}>
      {props.name}
    </button>
  ) : (
    <span className={className} style={style}>
      {props.name}
    </span>
  );
};
