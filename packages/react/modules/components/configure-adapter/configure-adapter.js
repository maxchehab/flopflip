// @flow

import type { Flags, Adapter, AdapterArgs, User } from '@flopflip/types';

import React, { PureComponent, type Node } from 'react';
import createReactContext, { type Context } from 'create-react-context';
import merge from 'deepmerge';

export const AdapterStates: {
  UNCONFIGURED: string,
  CONFIGURING: string,
  CONFIGURED: string,
} = {
  UNCONFIGURED: 'unconfigured',
  CONFIGURING: 'configuring',
  CONFIGURED: 'configured',
};

type Props = {
  shouldDeferAdapterConfiguration?: boolean,
  adapter: Adapter,
  adapterArgs: AdapterArgs,
  defaultFlags?: Flags,
  render?: () => Node,
  children?: ({ isAdapterReady: boolean }) => Node,
};
type State = {
  appliedAdapterArgs: AdapterArgs,
};
type AdapterState = $Values<typeof AdapterStates>;
type AdapterReconfigurationOptions = {
  shouldOverwrite?: boolean,
};
type AdapterReconfiguration = {
  adapterArgs: AdapterArgs,
  options: AdapterReconfigurationOptions,
};
type ReconfigureAdapter = (
  adapterArgs: AdapterArgs,
  options: AdapterReconfigurationOptions
) => void;

export const AdapterContext: Context<ReconfigureAdapter> = createReactContext(
  () => {}
);

const isEmptyChildren = (children: Node): boolean =>
  React.Children.count(children) === 0;

export const mergeAdapterArgs = (
  previousAdapterArgs: AdapterArgs,
  { adapterArgs: nextAdapterArgs, options = {} }: AdapterReconfiguration
): AdapterArgs =>
  options.shouldOverwrite
    ? nextAdapterArgs
    : merge(previousAdapterArgs, nextAdapterArgs);

export default class ConfigureAdapter extends PureComponent<Props, State> {
  static defaultProps = {
    shouldDeferAdapterConfiguration: false,
    children: null,
    render: null,
    defaultFlags: {},
  };

  adapterState: AdapterState = AdapterStates.UNCONFIGURED;
  pendingAdapterArgs: ?AdapterArgs = null;

  state: { appliedAdapterArgs: AdapterArgs } = {
    appliedAdapterArgs: this.props.adapterArgs,
  };

  setAdapterState = (nextAdapterState: AdapterState): void => {
    this.adapterState = nextAdapterState;
  };
  applyAdapterArgs = (nextAdapterArgs: AdapterArgs): void =>
    /**
     * NOTE:
     *   We can only unset `pendingAdapterArgs` after be actually perform
     *   a batched `setState` otherwise outdated `adapterArgs` as we loose
     *   the `pendingAdapterArgs` as we unset them too early.
     */
    this.setState(
      prevState => ({
        ...prevState,
        appliedAdapterArgs: nextAdapterArgs,
      }),
      () => {
        this.pendingAdapterArgs = null;
      }
    );

  /**
   * NOTE:
   *   This is passed through the React context (it's a public API).
   *   Internally this component has a `ReconfigureAdapter` type;
   *   this function has two arguments for clarify.
   */
  reconfigureOrQueue = (
    nextAdapterArgs: AdapterArgs,
    options: AdapterReconfigurationOptions
  ): void =>
    this.adapterState === AdapterStates.CONFIGURED &&
    this.adapterState !== AdapterStates.CONFIGURING
      ? this.applyAdapterArgs(
          mergeAdapterArgs(this.state.appliedAdapterArgs, {
            adapterArgs: nextAdapterArgs,
            options,
          })
        )
      : this.setPendingAdapterArgs({ adapterArgs: nextAdapterArgs, options });

  setPendingAdapterArgs = (
    nextReconfiguration: AdapterReconfiguration
  ): void => {
    /**
     * NOTE:
     *    The next reconfiguration is merged into the previous
     *    one instead of maintaining a queue.
     *
     *    The first merge with merge with `appliedAdapter` args
     *    to contain the initial state (through property initializer).
     */
    this.pendingAdapterArgs = mergeAdapterArgs(
      this.pendingAdapterArgs || this.state.appliedAdapterArgs,
      nextReconfiguration
    );
  };
  /**
   * NOTE:
   *    Whenever the adapter delays configuration pending adapterArgs will
   *    be kept on `pendingAdapterArgs`. These can either be populated
   *    from calls to `componentWillReceiveProps` or through `ReconfigureFlopflip`.
   *    Both cases go through `reconfigureOrQueue`.
   *
   *    In any case, when the adapter should be configured it should either
   *    be passed pending or applied adapterArgs.
   *
   */
  getAdapterArgsForConfiguration = (): AdapterArgs =>
    this.pendingAdapterArgs || this.state.appliedAdapterArgs;

  handleDefaultFlags = (defaultFlags: Flags): void => {
    if (Object.keys(defaultFlags).length > 0) {
      this.props.adapterArgs.onFlagsStateChange(defaultFlags);
    }
  };

  /**
   * NOTE:
   *   This should be UNSAFE_componentWillReceiveProps.
   *   However to maintain compatibility with older and newer versions of React
   *   this can not be prefixed with UNSAFE_.
   *
   *   For the future this should likely happen in cDU however as `reconfigureOrQueue`
   *   may trigger a `setState` it might have unexpected side-effects (setState-loop).
   *   Maybe some more substancial refactor would be needed.
   */
  componentWillReceiveProps(nextProps: Props): void {
    if (nextProps.adapterArgs !== this.props.adapterArgs) {
      /**
       * NOTE:
       *   The component might receive `adapterArgs` from `ReconfigureFlopflip`
       *   before it managed to configure. If that occurs the next `adapterArgs`
       *   passed in will overwrite what `ReconfigureFlopflip` passed in before
       *   yieling a loss in configuration.
       *
       *   Whenever however the adapter has configured we want to component to
       *   act in a controleld manner. So that overwriting will occur when the
       *   passed `adapterArgs` change.
       */
      this.reconfigureOrQueue(nextProps.adapterArgs, {
        shouldOverwrite: this.adapterState === AdapterStates.CONFIGURED,
      });
    }
  }

  componentDidMount(): Promise<any> | void {
    this.handleDefaultFlags(this.props.defaultFlags);

    if (!this.props.shouldDeferAdapterConfiguration) {
      this.setAdapterState(AdapterStates.CONFIGURING);

      return this.props.adapter
        .configure(this.getAdapterArgsForConfiguration())
        .then(() => {
          this.setAdapterState(AdapterStates.CONFIGURED);
          if (this.pendingAdapterArgs) {
            this.applyAdapterArgs(this.pendingAdapterArgs);
          }
        });
    }
  }

  componentDidUpdate(): Promise<any> | void {
    /**
     * NOTE:
     *    Be careful here to not double configure from `componentDidMount`.
     *    Moreover, cDU will also be invoked from `setState` to `appliedAdapterArgs`.
     *    Hence, avoid calling `setState` within cDU.
     */

    if (
      !this.props.shouldDeferAdapterConfiguration &&
      this.adapterState !== AdapterStates.CONFIGURED &&
      this.adapterState !== AdapterStates.CONFIGURING
    ) {
      this.setAdapterState(AdapterStates.CONFIGURING);

      return this.props.adapter
        .configure(this.getAdapterArgsForConfiguration())
        .then(() => {
          this.setAdapterState(AdapterStates.CONFIGURED);

          if (this.pendingAdapterArgs) {
            this.applyAdapterArgs(this.pendingAdapterArgs);
          }
        });
    } else if (
      this.adapterState === AdapterStates.CONFIGURED &&
      this.adapterState !== AdapterStates.CONFIGURING
    ) {
      this.setAdapterState(AdapterStates.CONFIGURING);

      return this.props.adapter
        .reconfigure(this.getAdapterArgsForConfiguration())
        .then(() => {
          this.setAdapterState(AdapterStates.CONFIGURED);
        });
    }
  }

  render(): Node {
    return (
      <AdapterContext.Provider value={this.reconfigureOrQueue}>
        {(() => {
          const isAdapterReady = this.props.adapter.getIsReady();

          if (isAdapterReady) {
            if (typeof this.props.render === 'function')
              return this.props.render();
          }

          if (typeof this.props.children === 'function')
            return this.props.children({
              isAdapterReady,
            });

          if (this.props.children && !isEmptyChildren(this.props.children))
            return React.Children.only(this.props.children);
        })()}
      </AdapterContext.Provider>
    );
  }
}
