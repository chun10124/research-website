import React from 'react';

const INITIAL_TAGS = [];

export const TagsContext = React.createContext({
  tags: INITIAL_TAGS,
  typeColors: Object.fromEntries(INITIAL_TAGS.map((t) => [t.value, t.color])),
});

export { INITIAL_TAGS };
